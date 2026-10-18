# -*- coding: utf-8 -*-
"""whisper_server.py - 常驻进程，麦克风按需开 -> faster-whisper 离线转写 -> stdout 每行一条字幕。
使用系统默认输入设备（跟随 Windows 默认录音设备）。采集取所有通道均值，
避免单一通道静音导致漏采。转写由 faster-whisper VAD 滤静音。
麦克风流只在 ptt down / 自动听时打开，闲置时不留"正在使用麦克风"的系统图标。
用法: python whisper_server.py [device_id]
"""
import sys, io, warnings, time, os, threading, queue
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
import numpy as np
import sounddevice as sd

warnings.filterwarnings("ignore")
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", line_buffering=True)
# stdin 也按 UTF-8 读：父进程会通过它发 pause / resume
sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding="utf-8", errors="replace", line_buffering=True)

MODEL_SIZE = "small"
CHUNK = 1024
SILENCE_SEC = 0.9
TARGET = 16000
# 按住 T 时用 WASAPI 独占打开麦克风：这段时间其他程序（腾讯会议、录音软件）
# 的采集流会被系统踢掉，收不到声音。松开后释放，让它们自己重新拿回设备。
PTT_EXCLUSIVE = True

DEVICE_ID = None
if len(sys.argv) > 1 and str(sys.argv[1]).strip() != "":
    try:
        DEVICE_ID = int(sys.argv[1])
    except Exception:
        DEVICE_ID = None

print("[sr] loading model...", flush=True)
from faster_whisper import WhisperModel
model = WhisperModel(MODEL_SIZE, device="cpu", compute_type="int8")

# 确定设备 / 采样率 / 通道（系统默认 或 指定）
try:
    if DEVICE_ID is None:
        raw = sd.default.device[0]
        if raw is None or raw < 0:
            raw = None
        DEVICE_ID = raw
    info = sd.query_devices(DEVICE_ID, "input") if DEVICE_ID is not None else sd.query_devices(kind="input")
    SR = int(info["default_samplerate"]) or 16000
    CHAN = int(info["max_input_channels"]) or 1
except Exception as e:
    print("[fatal] cannot resolve input device: " + str(e)[:120], flush=True)
    sys.exit(1)

print(f"[sr] using dev={DEVICE_ID} sr={SR} ch={CHAN}", flush=True)

def _norm_name(n):
    return "".join(str(n or "").lower().split())

def _same_device(a, b):
    a, b = _norm_name(a), _norm_name(b)
    if not a or not b:
        return False
    k = min(len(a), len(b), 20)        # MME 的名字会被截断，前缀比对比全等稳
    return a[:k] == b[:k]

# 同一个物理输入设备在 WASAPI 下是另一个设备号，而且独占格式因设备而异：
# 蓝牙耳机常见 16k 单声道，内置麦克风阵列常见 48k 4 声道。启动时探一次。
def probe_exclusive():
    try:
        apis = sd.query_hostapis()
        wi = next((i for i, a in enumerate(apis) if "WASAPI" in str(a.get("name", ""))), None)
        if wi is None:
            print("[sr] exclusive off: no WASAPI host api", flush=True)
            return None
        api = apis[wi]
        target = sd.query_devices(DEVICE_ID)["name"] if DEVICE_ID is not None else ""
        dev = None
        for i, d in enumerate(sd.query_devices()):
            if d["hostapi"] == wi and d["max_input_channels"] > 0 and _same_device(d["name"], target):
                dev = i
                break
        if dev is None:
            dev = api.get("default_input_device")
        if dev is None or int(dev) < 0:
            print("[sr] exclusive off: no WASAPI input", flush=True)
            return None
        maxch = int(sd.query_devices(dev)["max_input_channels"]) or 1
        for ac in (True, False):
            for ch in range(1, maxch + 1):
                for sr in (16000, 32000, 44100, 48000, 96000):
                    try:
                        sd.check_input_settings(device=dev, channels=ch, samplerate=sr, dtype="int16",
                                                extra_settings=sd.WasapiSettings(exclusive=True, auto_convert=ac))
                        return (dev, ch, sr, ac)
                    except Exception:
                        pass
        print("[sr] exclusive off: no supported exclusive format", flush=True)
    except Exception as e:
        print("[sr] exclusive off: " + str(e)[:120], flush=True)
    return None

EX_FMT = probe_exclusive() if PTT_EXCLUSIVE else None
if EX_FMT:
    print(f"[sr] exclusive available dev={EX_FMT[0]} ch={EX_FMT[1]} sr={EX_FMT[2]} ac={EX_FMT[3]}", flush=True)

# 采集取所有通道的均值（防单通道静音）
def to_mono(x):
    if x.ndim > 1 and x.shape[1] > 1:
        return np.mean(x.astype("float32"), axis=1)
    return x[:, 0].astype("float32") if x.ndim > 1 else x.astype("float32")

THRESH = 0.01   # 触发录音阈值（低），VAD 负责滤静音
print(f"[sr] ready (dev={DEVICE_ID}, sr={SR}, thresh={THRESH:.4f})", flush=True)

def resample(audio, sr):
    if sr == TARGET:
        return audio
    n = int(len(audio) * TARGET / sr)
    return np.interp(np.linspace(0, len(audio), num=n, endpoint=False), np.arange(len(audio)), audio).astype("float32")

def energy(x):
    return float(np.sqrt(np.mean(x*x)) + 1e-9)

audio_buffer = []
record_state = False
last_voice = time.time()

# 暂停 = 【不接收】：音频进来直接丢弃，不缓存也不转写。
# 注意这不是"转写完再扔掉"——那样话还是被听见了，只是没被用而已。
# 模型保持常驻，所以 resume 是立刻生效的，不用重新加载。
PAUSED = False

# 收话方式：
#   auto = 一直听（能量触发 + VAD 断句）
#   ptt  = 推按键：没按 T 的时候音频一律丢弃，只有 "ptt down" 到 "ptt up" 之间才进缓冲
# 这样任务期间既不听环境音，又能按住 T 插话——不是"听见了再忽略"。
MODE = "auto"
PTT_HELD = False
PTT_BUF = []
PTT_LOCK = threading.Lock()
PTT_SR = SR                # 这一段 PTT 音频的实际采样率（独占流可能和共享流不同）
TRANS_Q = queue.Queue()

CTRL_Q = queue.Queue()

def stdin_reader():
    try:
        for raw in sys.stdin:
            cmd = " ".join(raw.strip().lower().split())
            if cmd in ("pause", "resume", "mode auto", "mode ptt",
                       "ptt down", "ptt up", "ptt cancel"):
                CTRL_Q.put(cmd)
    except Exception as e:
        print("[err] stdin: " + str(e)[:120], flush=True)

# 音频流的开关必须回到主线程：PortAudio 在子线程里打开输入流会报
# "Invalid device" / MME 参数错误（实测）。stdin 线程只负责排队。
def handle_control(cmd):
    global PAUSED, audio_buffer, record_state, MODE, PTT_HELD, PTT_BUF
    if cmd == "pause":
        PAUSED = True
        audio_buffer = []; record_state = False   # 手上攒的半句也不要了
        stop_stream()
        print("[paused]", flush=True)
    elif cmd == "resume":
        PAUSED = False
        if MODE == "auto":
            start_stream()
        print("[resumed]", flush=True)
    elif cmd in ("mode auto", "mode ptt"):
        MODE = cmd.split()[1]
        with PTT_LOCK:
            PTT_HELD = False
            PTT_BUF = []
        audio_buffer = []; record_state = False
        if MODE == "auto" and not PAUSED:
            stop_stream()          # 切回共享流前，先放掉可能残留的独占流
            start_stream()
        else:
            stop_stream()          # ptt：没按 T 就不该占着麦克风
        print("[mode] " + MODE, flush=True)
    elif cmd == "ptt down":
        with PTT_LOCK:
            PTT_HELD = True
            PTT_BUF = []
        audio_buffer = []; record_state = False
        if PAUSED:
            with PTT_LOCK:
                PTT_HELD = False
        else:
            # 先抢独占：会议/录音这段时间会被系统踢出麦克风
            if not start_exclusive():
                start_stream()
        print("[ptt] listening", flush=True)
    elif cmd == "ptt up":
        stop_stream()             # 先停流再取缓冲：不会再有点回声进这段
        with PTT_LOCK:
            PTT_HELD = False
            buf = PTT_BUF
            PTT_BUF = []
        if buf:
            TRANS_Q.put((buf, PTT_SR))
        else:
            print("[ptt] idle", flush=True)
    elif cmd == "ptt cancel":
        # 误触（按住 T 只是打字）：这段音频直接扔掉，不转写、不出结果
        stop_stream()
        with PTT_LOCK:
            PTT_HELD = False
            PTT_BUF = []

def transcribe(samples, sr):
    audio = np.concatenate(samples).astype("float32")
    # 太短的片段不送模型：敲一下键、误触半秒，转出来只会是"没听清楚"这类废话。
    # 按实际采集率算时长：共享流用设备默认率，独占流可能是 16k 或 48k。
    if len(audio) < sr * 0.25:
        return ""
    audio16 = resample(audio, sr)
    segments, _ = model.transcribe(audio16, language="zh", vad_filter=True, beam_size=1)
    return " ".join(seg.text for seg in segments).strip()

# 推按键的转写放在单独线程里串行做：音频回调不能被打断，
# 连着按两次 T 时两句也要按顺序出结果。busy/idle 让界面能显示"识别中…"。
def transcribe_worker():
    while True:
        buf, sr = TRANS_Q.get()
        try:
            print("[ptt] busy", flush=True)
            txt = transcribe(buf, sr)
            if txt:
                print(txt, flush=True)
        except Exception as ex:
            print("[err] " + str(ex)[:140], flush=True)
        finally:
            print("[ptt] idle", flush=True)

threading.Thread(target=transcribe_worker, daemon=True).start()

def callback(indata, frames, t, status):
    global record_state, last_voice, audio_buffer
    if PAUSED:                    # 不接收：这段音频根本不进缓冲区
        if record_state or audio_buffer:
            audio_buffer = []; record_state = False
        return
    x = to_mono(indata) / 32768.0
    if PTT_HELD:                  # 按住 T：只往这一段的缓冲里放，不走自动断句
        with PTT_LOCK:
            if PTT_HELD:
                PTT_BUF.append(x.copy())
        return
    if MODE == "ptt":             # 任务期间没按 T：音频直接丢，不缓存不转写
        return
    e = energy(x)
    if record_state:
        audio_buffer.append(x.copy())
        if e < THRESH:
            if time.time() - last_voice > SILENCE_SEC:
                try:
                    txt = transcribe(audio_buffer, SR)
                    if txt:
                        print(txt, flush=True)
                except Exception as ex:
                    print("[err] " + str(ex)[:140], flush=True)
                audio_buffer = []; record_state = False
        else:
            last_voice = time.time()
    else:
        if e > THRESH:
            record_state = True
            audio_buffer = [x.copy()]
            last_voice = time.time()

# 麦克风流只在需要时开着：闲置时 Windows 通知栏不会挂"正在使用麦克风"的图标。
# 代价是按下 T 那一刻才开流，前几十毫秒可能丢；PTT 模式下用户按住的通常不止这点时间。
STREAM = None        # 共享流（自动听 / 独占不可用时的退路）
EX_STREAM = None     # 独占流（按住 T 时用）
STREAM_LOCK = threading.Lock()

def start_stream():
    global STREAM, EX_STREAM, PTT_SR
    with STREAM_LOCK:
        if EX_STREAM is not None and EX_STREAM.active:
            try:
                EX_STREAM.stop()
            except Exception:
                pass
        if STREAM is not None:
            try:
                if not STREAM.active:
                    STREAM.start()
                PTT_SR = SR
                return True
            except Exception as e:
                print("[err] mic start: " + str(e)[:140], flush=True)
                try:
                    STREAM.close()
                except Exception:
                    pass
                STREAM = None
        try:
            STREAM = sd.InputStream(device=DEVICE_ID, samplerate=SR, channels=CHAN,
                                    dtype="int16", callback=callback, blocksize=CHUNK)
            STREAM.start()
            PTT_SR = SR
            return True
        except Exception as e:
            print("[err] mic open: " + str(e)[:140], flush=True)
            STREAM = None
            return False

def start_exclusive():
    global EX_STREAM, PTT_SR
    if EX_FMT is None:
        return False
    dev, ch, sr, ac = EX_FMT
    with STREAM_LOCK:
        if EX_STREAM is not None:
            try:
                if not EX_STREAM.active:
                    EX_STREAM.start()
                PTT_SR = sr
                print("[sr] exclusive on", flush=True)
                return True
            except Exception as e:
                print("[sr] exclusive off: " + str(e)[:140], flush=True)
                try:
                    EX_STREAM.close()
                except Exception:
                    pass
                EX_STREAM = None
        try:
            EX_STREAM = sd.InputStream(device=dev, channels=ch, samplerate=sr, dtype="int16",
                                       callback=callback,
                                       extra_settings=sd.WasapiSettings(exclusive=True, auto_convert=ac))
            EX_STREAM.start()
            PTT_SR = sr
            print("[sr] exclusive on", flush=True)
            return True
        except Exception as e:
            print("[sr] exclusive off: " + str(e)[:140], flush=True)
            EX_STREAM = None
            return False

def stop_stream():
    global STREAM, EX_STREAM
    with STREAM_LOCK:
        for s in (STREAM, EX_STREAM):
            if s is not None:
                try:
                    if s.active:
                        s.stop()
                except Exception:
                    pass

# 命令线程最后启动：保证 start_stream / callback / transcribe_worker 都已就绪，
# 父进程一启动就发 pause/mode 也不会撞上空函数。
threading.Thread(target=stdin_reader, daemon=True).start()

try:
    while True:
        try:
            handle_control(CTRL_Q.get(timeout=0.05))
        except queue.Empty:
            pass
except KeyboardInterrupt:
    pass
finally:
    stop_stream()