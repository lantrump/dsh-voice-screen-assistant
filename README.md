# DSH 语音屏幕助手

一个常驻桌面的语音助手：按住 T 说话，它看懂屏幕后要么直接回答，要么用真实的鼠标键盘替你在电脑上操作。

- 本地 Whisper 离线识别，语音不上传
- 视觉模型（DeepSeek）判断屏幕内容并给出下一步动作
- 运行期间可以按住 T 插话，说「暂停」立即停手
- 窗口从任务栏、Alt+Tab 和所有抓屏/录屏里隐藏
- 按住 T 时用 WASAPI 独占麦克风，会议软件这段时间收不到你的声音
- 闲置时不占用麦克风

仅支持 Windows 10/11。

## 安装

1. 安装 [Node.js](https://nodejs.org/)
2. 安装 Python 3.10+，并确保命令行里 `python` 可用
3. 安装依赖：

```bat
npm install
python -m pip install -r requirements.txt
```

如果 Python 不在默认位置，可以设置环境变量 `PYTHON` 指向解释器路径（例如 `set PYTHON=C:\Python312\python.exe`）。

## 运行

```bat
npm start
```

也可以双击 `启动语音助手.bat`。

首次启动会下载 Whisper `small` 模型（默认走 hf-mirror 镜像），需要联网。

## 使用

1. 点「开启语音」，选择麦克风和捕捉源
2. 点「API Key」，填入自己的 DeepSeek API Key（只保存在本机）
3. 点「开始捕捉」
4. 按住 T 说话，松开结束；单独敲一下 t 仍然是正常打字

API Key 不会写进代码或仓库，只存在本机的 `%APPDATA%\dsh-voice-screen-assistant` 下。

## 测试

```bat
npm test
```

单元测试不需要 API Key、不联网。

## 说明

- 语音识别使用 [faster-whisper](https://github.com/SYSTRAN/faster-whisper)，模型在首次运行时自动下载
- 桌面操作通过 `desktop_ctl.py` 调用 Windows API（SendInput）
- `runs/` 是本机的任务截图与日志目录，已在 `.gitignore` 中排除
