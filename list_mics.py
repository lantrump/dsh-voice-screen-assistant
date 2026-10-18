# -*- coding: utf-8 -*-
"""list_mics.py - 输出干净输入设备(去重,优先耳机): [{id,name,kind,label}]"""
import sys, json, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
import sounddevice as sd

def norm(n):
    n=(n or "").lower()
    return n

# 决定某个设备是耳机还是麦克风（排除虚拟/捕获/映射器/阵列重复）
def classify(name):
    n=norm(name)
    if any(k in n for k in ["headphone","耳机","bthhf","hands-free","hands free"]):
        return "headphone"
    if any(k in n for k in ["本机麦克风","麦克风","microphone"]):
        # 排除映射器/捕获这类虚拟
        if any(x in n for x in ["映射","capture","声音"]):
            return None
        return "mic"
    return None

groups={"headphone":None,"mic":None}
try:
    for i,d in enumerate(sd.query_devices()):
        if d["max_input_channels"]<=0: continue
        k=classify(d["name"])
        if k is None: continue
        if groups[k] is None:
            groups[k]={"id":i,"name":str(d["name"]),"kind":k,"channels":int(d["max_input_channels"]),"sr":int(d["default_samplerate"] or 0)}
except Exception as e:
    pass

out=[]
for k,label in [("headphone","耳机"),("mic","麦克风")]:
    g=groups.get(k)
    if g:
        g["label"]=label
        out.append(g)
print(json.dumps(out, ensure_ascii=False))