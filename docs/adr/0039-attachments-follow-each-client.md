# 0039. Send each attached file the way its client takes it

- Status: Accepted
- Date: 2026-10-25

## Context

A message could only name a file by its path in the text. A model reads a path as a string, so an image or a PDF never reached it, and a path inside the scratch copy would have ridden into the next Accept. The four clients also differ. Anthropic's input protocol has blocks for images and documents. OpenAI's app-server has local image and audio inputs and lists what each model takes. Google's ACP agent declares at initialize which prompt blocks it takes. Local models see an image only when the loaded model reports vision. I want one way to attach a file, each client getting the form it takes, and a way forward when it takes none.

## Decision

- The controller copies each attached file into its home at `chat/<task>/files/<sha256>/<name>`. The message records the name, the detected MIME type, the size and the hash. The scratch copy never holds an attachment, so Accept cannot carry one into my repository. Bytes already stored for the thread are reused, and deleting the thread removes its files folder.
- The controller reads the type from the first 64 KiB of the file, then from the extension, then from the type a paste declared. A message holds up to 32 files. Files attach before the first send and on a queued message.
- The picker is a native dialog in the main process, which returns paths. A drop or a paste gives the page a file object, and the preload asks Electron for its path. Main checks that each path is a regular file and returns its name, its size and, for a picture the platform can decode, a 96 pixel thumbnail.
- A pasted screenshot has no file. Main reads the clipboard image and writes it as a PNG in a private folder under the system temp path. It keeps the newest 32, removes the folder when the window closes and refuses an image over 32 MiB.
- The renderer sends `ImportChatAttachment` with the path, and the controller copies the file in 1 MiB chunks while it hashes. The desktop sends no file bytes over the controller socket, because one socket frame holds 1 MiB at most.
- Anthropic: the adapter uses the block types the stream-json input defines. Images of type JPEG, PNG, GIF and WebP go as image blocks, a PDF as a document block, and a UTF-8 file with a `text/` type as a text document block. The blocks come before the message text and are read from the stored file when the turn starts. Any other file goes as a path line in the text, and the files folder joins the launch through `--add-dir` so the model's tools can open it.
- OpenAI: the adapter reads each model's `inputModalities` from `model/list`. An image other than SVG goes as `localImage`, and audio with an extension the client maps (wav, mp3, m4a, webm or ogg) goes as `localAudio`, when the selected model lists that modality. Any other file goes as a path line. The client does not fail on a local file it cannot use. It puts placeholder text in the prompt and runs the turn, so the reply reads as though the file was never attached. The adapter therefore checks before it opens a thread: the file is readable, an audio file has a mapped extension and the model lists the modality. A file that fails ends the turn as `attachment-rejected`.
- Google: the adapter reads `agentCapabilities.promptCapabilities` at each initialize. An image gets an image block when `image` is set, audio gets an audio block when `audio` is set, and any file gets an embedded resource, as text or as a blob, when `embeddedContext` is set. Everything else goes as a `resource_link`, which the protocol requires every agent to accept. A thread connection takes a prompt line of 20 MiB, less a 16 KiB margin for the envelope, and the writer connection keeps 1 MiB. A file whose base64 form would not fit goes as a link, and a notice names it.
- Local: the adapter reads the loaded model's `vision` flag when it connects. An image goes through `files.prepareImageBase64` and rides on the message when the flag is set. A text file is inlined under its name. The inlined types are `text/*` and a short list: JSON, XML, YAML, TOML, JavaScript, SQL and shell. Any other file ends the turn as `attachment-rejected` before the model runs, with the reason for each file.
- `attachment-rejected` is a failure kind whose next action reads "Try another provider for these files." It carries the provider's own message where there is one. Anthropic maps `invalid_request` or status 400, and only on a turn that sent native blocks, since a context overflow returns 400 as well. OpenAI maps `badRequest` on a turn that sent images or audio. Google maps a JSON-RPC error on `session/prompt` when the prompt held a block that is not text. Local maps its own checks and an image LM Studio refuses.
- The failure line offers Try with. It lists the connected families that have not tried that message. Families whose client reported that it takes every file type on the message come first, and the rest follow in the thread's handoff mode order. Each runs its default model. Choosing one calls `RetryChatTurn` with that selection, which takes the handoff path: the handoff line, the packet, and the files of the message and of earlier messages inside the packet's window.
- The catalog reports accepted types per family from what the client said. Anthropic reports its fixed block list. OpenAI reports image and audio from the default model's `inputModalities`. Google reports from the last initialize, where an embedded resource covers every type. Local reports its text types, plus images when the model has vision. A family that reported nothing has no list, and the composer shows no line for it.
- Before I send, a chip shows one line, such as "Google may not take this file type", when the selected family reported accepted types and none matches the file. Send still works.
- CrewKite sets no limit on the type or size of a file it copies from disk. The limits that exist are 32 files per message, 32 MiB for a pasted image, and whatever each client enforces.

## Why

The hash names the bytes, so a file attached twice, or sent again after a retry on another provider, costs one copy. The files sit outside the scratch copy because Accept commits whatever the copy holds, and an attachment is input to a thread, not part of my project.

I send paths over the socket because the 1 MiB frame bounds every command, and I would not loosen it for one command. A path costs a few bytes, the controller reads the file itself, and a screenshot becomes a path once main writes it to disk.

A path in the text sends the model to read the file with a tool, if it has one, and it cannot see an image that way. So each adapter uses the client's own block whenever the protocol has one for the type, and a path line only when it has none.

I keep no list of accepted types in CrewKite. Each client already knows what it takes, and any list I wrote would go stale at the next client update. The catalog carries what the client reported, the chip line and the Try with order read only that, and a client that says no gives the person its own words.

A silent placeholder is worse than a refusal, because the model answers as if it had seen the file. That is why the OpenAI adapter checks before the thread opens.

Try with puts the families that reported the type first because the next step after a rejection is to pick a provider that takes it, and the catalog already knows. Ties and families with no report follow the handoff mode, the same order a usage limit uses.

## Consequences

- A stored file stays until I delete the thread. Nothing prunes the folder, and two threads that hold the same file hold two copies.
- A large import copies inside the command. The copy is synchronous, so a file of several gigabytes blocks the controller while it runs, and the composer holds Send until the copy ends.
- The import command also accepts base64 bytes, capped at 32 MiB per item in its schema. A 1 MiB frame cannot carry that much, and the desktop does not use the form.
- The OpenAI precheck covers readability, audio extension and modality. It cannot tell whether the client can decode a given image. A format it cannot decode, HEIC for example, passes the check as an image, and the client may replace it with placeholder text.
- Local keeps its file tools inside the scratch copy by resolving each path the way the kernel does and comparing the opened file. A hard link in the copy to a file outside it passes, because no path check can see a hard link.
- The Google report lives in controller memory and is read again at each initialize. Until a Google turn has run since the controller started, the catalog reports nothing for Google and the chip shows no line. Local's `vision` flag comes from its last connect, so until a Local turn has run on the loaded model the catalog lists no image type for Local, and the chip can warn about an image the model would take.
- A message cannot carry files without text. The send command, the queued message and the stored entry each need at least one character of text, and the composer keeps Send off until there is some. Files-only messages need their own design.
- A stored file that has gone missing is left out of a handoff request when it belongs to an earlier message, and it fails the turn when it belongs to the new one.
- The attachment paths and the Try with order have fixture coverage and no live run on record. [Provider routes](../providers.md) says Live qualification pending for each provider.
