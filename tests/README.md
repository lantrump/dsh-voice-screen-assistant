# 测试目录

## 怎么跑

```powershell
# 默认：只跑离线、无副作用的测试
powershell -ExecutionPolicy Bypass -File tests\run-tests.ps1

# 额外跑"手"的测试（会移动鼠标几下，结束前自动恢复原位；会覆盖剪贴板内容）
powershell -ExecutionPolicy Bypass -File tests\run-tests.ps1 -Hardware

# 额外跑视觉定位实测（需要用环境变量给 key，会产生 API 费用）
$env:DEEPSEEK_API_KEY = "sk-..."
powershell -ExecutionPolicy Bypass -File tests\run-tests.ps1 -Live
```

也可以单独跑某一个：

```powershell
node tests\test-action-layer.mjs
F:\miniconda3\python.exe tests\test_desktop_ctl.py
```

## 用例清单

| 用例 | 覆盖什么 | 有副作用吗 |
|---|---|---|
| `test-speech-queue.mjs` | 语音识别结果不丢句、服务状态行不被当成"用户说的话"、whisper 崩溃会报错、运行中换麦克风生效 | 无 |
| `test-agent-input-wiring.mjs` | 主进程与 `desktop_ctl.py` 的协议：请求应答配对、乱序不串台、分片 JSON、脏输出忽略、超时、进程退出与自愈 | 无 |
| `test-model-dropdown.mjs` | 模型列表来自接口、无视觉模型被标注、记忆上次选择、模型下架后回退到"能看图"的那个、各种失败兜底 | 无 |
| `test-action-layer.mjs` | 归一化坐标换算、越界夹紧、动作 JSON 的容错解析与拒绝、动作执行路由 | 无 |
| `test-agent-loop.mjs` | agent 循环：每步重新截图、动作后留出重绘时间、随时叫停（按钮与全局热键）、解析失败/执行失败熔断、管理员窗口拦下不算失败（继续循环、只提醒一次、连撞 3 次才停）、重复点击与连滚只提醒不拦（真空转才停下问你）、交卷前自查、模型接口报错 | 无 |
| `test-crop-annotate.mjs` | 落点放大图：准星像素数学（中心留洞、洋红、四边夹紧）、`annotate-crop` IPC 链路（含 `marked:false` 不画准星）、点前放大瞄准一次（裁图坐标映射回屏幕、失败回退原落点）、点完只【单独】读一次状态而不把图塞进动作请求、`look` 动作只看不动鼠标 | 无 |
| `test_desktop_ctl.py` | 真机：DPI 感知、物理像素尺寸、鼠标移动读回、滚轮、中文进剪贴板、异常不崩 | **会移动鼠标、改剪贴板** |
| `live/test-vision-grounding.mjs` | 实测视觉模型的定位精度，并对比"归一化坐标 vs 像素坐标" | **联网、花 API 费用** |
| `live/test-crop-feedback.mjs` | 实测：把落点放大图塞进"要它出坐标"的请求【有害】（10.5px → 36.2px）；这张图唯一站得住的本事是【读控件状态】（36/36 全对）——`readCropState` 的依据 | **联网、花 API 费用** |
| `live/test-click-refine.mjs` | 实测 11px 小目标的定位：整屏 21.1px/0 中、窗口裁图 8.9px/12 中、裁图内重定位 2.6px/15 中——`refineClickPoint` 的依据；模型定位精度会漂，值得定期重跑 | **联网、花 API 费用** |

## 设计原则

**用假的边界驱动真的源码。** `lib/fake-dom.mjs` 在 `vm` 里跑真实的 `renderer.js`，`lib/fake-electron.mjs` 用假 Electron 加载真实的 `main.js`。测试的是产品代码本身，不是它的副本——代码改了，测试立刻能反映出来。

**离线优先。** 默认跑的用例不联网、不动鼠标、不花钱，随时可跑。有副作用的用例必须显式加开关。

**只测真实存在的外部依赖。** `desktop_ctl.py` 用真 Windows API（这是它的全部意义），所以它的测试会真的移动鼠标——但会先记住原位置，结束时恢复。

## 加新用例

1. 在 `tests/` 下新建 `test-xxx.mjs`
2. 用 `lib/check.mjs` 的断言器收集结果并以 `c.done()` 收尾
3. 需要 DOM/主进程时用 `lib/fake-dom.mjs` / `lib/fake-electron.mjs`
4. 在 `run-tests.ps1` 里加一行 `Run-Node`

## 踩过的坑（写测试时会遇到）

- **`const` / `let` 不会挂到 vm 的 sandbox 上**，只有 `function` 声明会。要读写 renderer 里的词法变量，用 `app.run('state.model = ...')`。
- **元素桩必须让 `innerHTML = ''` 真的清空子元素**，否则会测出"下拉框里有 4 个选项"这种假重复。
- **PowerShell 5.1 读无 BOM 的 UTF-8 脚本会把中文读成乱码**。所以 `run-tests.ps1` 是**纯 ASCII** 的——任何工具改它都不会弄坏解析。用例本身的输出仍然是中文，不受影响。
- **受限环境下 Node 的管道 stdio 会被拦**（`child_process` 默认 `stdio:'pipe'` 报 EPERM），所以别用"真 spawn 一个 Python 再喂 stdin"的方式测，改成导入模块直接调函数。
