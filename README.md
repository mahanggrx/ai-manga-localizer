# AI Manga Localizer

本项目是一个本地优先的日漫转简体中文质量编排器。它不重复实现漫画视觉模型，而是通过 Koharu 0.61.2 的本机 HTTP API 驱动检测、OCR、翻译、修复、排字和导出，并补充安全归档、章节级重试、质量报告与金标评测。

当前版本面向个人、非商业使用。默认不联网处理漫画；只有显式传入 `--allow-cloud` 且配置了云端 provider 时，Koharu 才会把需要回退的 OCR 文本发送给 provider。原始图片不会发送到云端。

## 已实现

- `doctor`：只读检查 NVIDIA GPU、Koharu 版本/引擎目录和模型锁，不下载、不安装、不启动服务。
- `translate`：支持图片目录、ZIP、CBZ；每次创建唯一输出目录，驱动 Koharu 分阶段处理，按阅读页序分块并携带重叠上下文，执行 OCR 回退、翻译重试、可选文字云回退并导出图片、CBZ、KHR、manifest 和报告。重试后仍有严格阻断项的页面不会进入修复与排字，而是按原顺序回填原图，避免异常译文破坏画面。零检测页、当前无法保证只加小注的纯艺术字页，以及文本分布和 QA 同时呈现结构风险的首尾页也会失败关闭；报告只记录页面 ID 和保护原因码。
- 原图边界：`translate` 无条件要求 Koharu 使用 `localhost`、`127.0.0.1` 或 `::1`。即使诊断配置允许远程 Koharu，也不会把漫画图片上传到远程地址。
- `benchmark`：读取私有金标集和离线候选结果，计算检测召回率、OCR CER、语义可用率、术语一致性、免编辑页面率、修复排字评分、指定样本不拒译率和显存硬门槛，机械选择模型并生成锁文件。
- ZIP/CBZ 防护：拒绝路径穿越、绝对路径、盘符、ADS、符号链接、加密、ZIP64、未知压缩、CRC 错误和压缩炸弹式超限。
- 第三方运行时依赖保持最小化：除 Node.js 24 内置能力外，仅使用锁定版本的 `sharp` 在内存中解码受资源上限约束的 Koharu WebP 气泡蒙版。

## 前置条件

1. Node.js 24 或更高版本。
2. 已由你自行安装并启动的 Koharu 0.61.2，例如固定在 `127.0.0.1:4000`。本项目不会替你下载或启动它。
3. Koharu 中已安装检测、PaddleOCR-VL 1.6、Manga OCR、AOT、LaMa、渲染器及本地翻译模型。
4. 翻译模型和字体位于你明确选择的本地缓存中，不放入本仓库。

复制 `localizer.config.example.json` 为不提交 Git 的 `localizer.config.json`，按实际 Koharu 引擎和模型调整配置。云端回退默认没有配置。

主翻译目标既可以是 Koharu 内置的 `kind: "local"` 模型，也可以是 `providerId: "openai-compatible"` 的本机 llama.cpp/LM Studio 服务。后一种配置在任何页面上传前都会核对 Koharu 中保存的 provider 地址；只有 `localhost`、`127.0.0.1` 或 `::1` 会被视为本地目标，其他地址失败关闭。真正的云端 provider 只能配置为 `cloudTarget`，并且仍需命令行显式传入 `--allow-cloud`。

带 `<think>` 前缀的本地翻译模型不能直接接入 Koharu，否则思考文本可能成为气泡内容。`src/local-openai-proxy.ts` 提供一个只监听回环地址的适配器：它只转发模型发现和非流式 Chat Completions，在内存中移除完整的前置思考块，规范化完整顺序编号列表开头的全角冒号，并把漫画翻译请求固定为 0.3 温度和最多 2048 个输出 token；标签缺失、位置异常、流式请求、超限响应或非本机上游都会失败关闭，且不记录请求或响应正文。JSON 响应显式声明 UTF-8。客户端取消时，适配器会同时中断上游推理。启动示例：`node src/local-openai-proxy.ts --upstream http://127.0.0.1:8080 --port 8081`，随后把 Koharu 的 OpenAI Compatible 地址设为 `http://127.0.0.1:8081/v1`。

`doctor` 会报告可用物理内存与 Windows 提交额度；`translate` 在检测/OCR 和加载本地翻译模型前还会重新检查，默认至少保留 4096 MiB 可用物理内存和 8192 MiB 提交余量，测量失败或余量不足时不会启动重型阶段。8GB 显存上运行 GGUF 时应保持模型单实例，并优先使用 llama.cpp 的 `--no-mmap`；推理模型的 reasoning parser 应按其模型卡选择，不能假定所有模型都兼容 DeepSeek 格式。

模型专用提示词属于模型配置的一部分。例如 Murasaki 的官方模型卡要求漫画对话使用 Script Mode；通用翻译提示只能用于连通性 smoke，不能据此冻结默认模型。模型仍须通过仓库金标门槛后才能写入锁文件。

实验性 MangaTranslator v1.22.0 checkout 在运行前必须应用 `patches/manga-translator-v1.22.0-local-safety.patch`。补丁修复布尔配置被当作数值钳制的问题，并把控制台中的 OCR/模型正文改为只记录区域计数；运行方还必须显式提供包含中文字体文件的 `--font-dir`，否则清字可能成功而排字为空。

本机开发布局：Koharu 0.61.2 便携版位于 `.local/koharu/koharu-0.61.2.exe`，外部 GGUF 模型缓存使用 `.local/models/`，合法私有 smoke 样本放入 `private-smoke/`。这三个路径都由 `.gitignore` 排除；Koharu 自己按官方设计写入的运行库和内置模型仍位于其用户级应用数据目录。

`translation.chunkPages` 控制每个章节翻译块的页数，`translation.contextOverlapPages` 控制相邻块重复携带的上下文页数，后者必须小于前者。默认值为 4 页与 1 页。

## 使用

当前建议先用个人 MVP 路线。它会自动启动本机 Hy-MT2、调用已安装的 MangaTranslator，处理完成后停止模型服务；支持单张图片、图片目录、ZIP 和 CBZ，不需要管理员权限，也不会联网或下载模型：

```powershell
node src/cli.ts translate-mvp C:/manga/chapter-01 --out C:/manga/output
node src/cli.ts translate-mvp C:/manga/chapter-01.cbz --out C:/manga/output
```

结果位于新建的 `translation-results-mvp-*` 目录，其中 `images/` 是逐页 PNG，`report.json` 记录完成、部分完成或失败状态。这个入口以尽快获得可阅读结果为目标；当前主要处理气泡文字，气泡外旁白和艺术字仍可能保留原文。原有 `translate` 命令继续作为实验性 Koharu 质量路线保留。

```powershell
node src/cli.ts doctor
node src/cli.ts doctor --json
node src/cli.ts translate C:/manga/chapter-01 --out C:/manga/output
node src/cli.ts translate C:/manga/chapter-01.cbz --out C:/manga/output --psd
node src/cli.ts benchmark C:/manga/golden-private --out C:/manga/benchmark-output
```

开启云端文字回退前，必须在配置中设置 `translation.cloudTarget`，并在当次命令中显式加入 `--allow-cloud`。不开该参数时，编排器不会选择云端 target。

## 输出

`translate-mvp` 的输出只有 `images/` 和不含漫画正文的 `report.json`。

一次成功或部分成功的翻译会创建新的 `translation-results-*` 目录，绝不覆盖已有文件。目录包含：

- `rendered/`：逐页渲染图片。
- `translated.cbz`：重新封装的 CBZ。
- `chapter.khr`：可在 Koharu 中继续检查的项目。
- `chapter-manifest.json`：OCR、译文候选、区域策略、术语和 QA 标记。
- `report.json`：阶段状态、云回退范围、产物和恢复错误。
- `checkpoints/`：不含漫画文字的不可覆盖阶段检查点。
- `editable-psd.psd` 或 `editable-psd.zip`：仅在 `--psd` 时生成。
- `recovery-partial.khr`、`recovery-rendered/`、`recovery-partial.cbz`：仅在流水线失败且 Koharu 仍能导出部分成果时尽力生成。

`report.json.renderSafety` 会记录正常渲染页数、保留原图的页面及其原因码，包括阻断 QA、零检测、纯艺术字和高风险边界页。`completed-with-warnings` 只表示产物可恢复且结构完整，不表示已经达到发布质量；只要存在保留页、残留假名、溢出或其他错误级 QA，就仍需复检。

## 金标格式

金标目录必须包含 `golden.json` 和每个候选的结果 JSON。真实漫画、OCR 文本和译文应留在 `golden-private/` 或工作区外，不提交 Git。

`golden.json` 的关键字段为：

```json
{
  "schemaVersion": 1,
  "benchmarkId": "chapter-style-v1",
  "koharuVersion": "0.61.2",
  "availableVramMiB": 8188,
  "regions": [
    { "id": "r1", "pageId": "p1", "expectedOcr": "原文", "nonRefusalRequired": false }
  ],
  "candidates": [
    {
      "id": "candidate-a",
      "resultsFile": "candidate-a.json",
      "model": {
        "id": "candidate-a",
        "family": "translation-model-family",
        "version": "model-version",
        "quantization": "verified-quantization",
        "sha256": "64位小写SHA-256",
        "license": "CC-BY-NC-SA-4.0",
        "role": "translation"
      }
    }
  ]
}
```

候选结果按区域提供 `detected`、`ocrText`、`translation`、人工标注的 `semanticUsable`、`termsCorrect`、`layoutOk`，并提供真实 `peakVramMiB` 和页面 `repairLetteringScore`。没有人工标注时，评测会保守记为不通过，不会编造质量。

## 当前验证边界

单元测试和模拟 Koharu 契约可以在无模型环境运行。当前已完成真实三页 GPU 安全回归，验证阻断页像素原样保留、正常页渲染以及混合格式 CBZ 的条目完整性；也完成了一次 50 页候选基线，但其中仍有 OCR、残字、溢出和角色分类问题。50 页尚未完成人工金标，因此模型锁、语义指标和正式质量验收仍未完成，本项目不会声称已经达到汉化组水平。

Koharu 采用 GPL-3.0；当前默认的 Sakura-GalTransl-7B v3.7 模型采用 CC-BY-NC-SA-4.0。当前方案只按个人非商业用途设计，发布或商业化前必须重新审查所有代码、模型、字体和数据许可证。
