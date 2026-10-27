# 英语听写复习

一个可在本地或服务器运行的英语听写复习网页，支持词库管理、间隔复习、在线美式朗读和语音转文字。

## 功能

- 添加、校验和管理英语单词、词组或句子
- 听写练习、结果检查和复习进度统计
- Azure Neural TTS 美式男女声，未配置时回退到浏览器声音
- 本地 Whisper 或 OpenAI 语音转文字
- 服务端 JSON 存储，可在同一服务的多个浏览器间同步

## 快速开始

需要 Node.js 20 或更高版本。

```bash
npm start
```

然后打开：

```text
http://127.0.0.1:8787/english-dictation-review.html?shared=1
```

首次启动时会自动创建空白的 `data/library.json`。

## 可选语音服务

复制 `data/tts.env.example` 为 `data/tts.env`，按需填写 Azure Speech 或 OpenAI 配置。`data/tts.env` 已被 Git 忽略，不会提交到仓库。

在线美式朗读可配置：

```text
AZURE_SPEECH_KEY=你的 Azure Speech key
AZURE_SPEECH_REGION=你的 Azure region，例如 eastus
```

OpenAI 语音转文字可配置：

```text
OPENAI_API_KEY=你的 OpenAI API key
OPENAI_TRANSCRIBE_MODEL=gpt-4o-transcribe
```

也可使用本地 `whisper.cpp`，通过下面两个环境变量指定程序和模型：

```text
LOCAL_WHISPER_BIN=/path/to/whisper-cli
LOCAL_WHISPER_MODEL=/path/to/ggml-base.en.bin
```

## 局域网共享

macOS / Linux：

```bash
HOST=0.0.0.0 PORT=8787 npm start
```

Windows PowerShell：

```powershell
$env:HOST="0.0.0.0"
$env:PORT="8787"
npm start
```

同一局域网内可访问：

```text
http://服务器IP:8787/english-dictation-review.html?shared=1
```

## 隐私与数据

个人词库和复习记录保存在 `data/library.json`。这个文件已被 Git 忽略，不会上传到公开仓库。迁移或备份个人数据时，请单独保存该文件。

Whisper 模型、编译产物、语音缓存、日志和密钥配置也不会提交。

## 部署说明

项目包含 Node.js 服务端，不能仅靠 GitHub Pages 实现数据同步和语音服务。可以部署到 Render、Railway、VPS、NAS 或其他支持 Node.js 的平台。

## 许可证

[MIT](LICENSE)
