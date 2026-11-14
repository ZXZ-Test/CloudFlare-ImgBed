export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const update = await request.json();
    const message = update.message || update.channel_post;
    if (!message) return new Response("OK", { status: 200 });

    const chatId = message.chat.id;
    const userId = message.from ? message.from.id : null;

    // 1. 权限校验
    if (env.ALLOWED_USERS) {
      const allowedList = env.ALLOWED_USERS.split(",").map(id => id.trim());
      if (userId && !allowedList.includes(String(userId))) {
        return new Response("Unauthorized user", { status: 200 });
      }
    }

    // 2. 解析目标存储文件夹（支持环境变量 TG_UPLOAD_FOLDER，也支持发图时附带 #目录名 动态覆盖）
    let rawFolder = env.TG_UPLOAD_FOLDER || "";
    const caption = (message.caption || "").trim();
    if (caption.startsWith("#") || caption.startsWith("/dir ")) {
      rawFolder = caption.replace(/^(\/dir\s+|#)/, "").trim();
    }

    // 格式化目录：去除首尾多余斜杠和非法字符，非空时统一以 "/" 结尾（如 "telegram/"）
    const cleanFolder = rawFolder
      .replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, "")
      .replace(/\.\./g, "");
    const uploadDir = cleanFolder ? `${cleanFolder}/` : "";

    // 3. 提取图片或文件信息并精准识别 MIME 类型与字节大小
    let fileId = null;
    let fileExt = "jpg";
    let fileName = `tg_${Date.now()}.jpg`;
    let fileSize = 0;
    let mimeType = "image/jpeg";

    const mimeMap = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      webp: "image/webp",
      svg: "image/svg+xml",
      bmp: "image/bmp",
      ico: "image/x-icon",
      mp4: "video/mp4",
      webm: "video/webm",
      mp3: "audio/mpeg",
      wav: "audio/wav",
      pdf: "application/pdf"
    };

    if (message.photo && message.photo.length > 0) {
      const largestPhoto = message.photo[message.photo.length - 1];
      fileId = largestPhoto.file_id;
      fileSize = largestPhoto.file_size || 0;
      fileExt = "jpg";
      fileName = `tg_${Date.now()}.jpg`;
      mimeType = "image/jpeg";
    } else if (message.document) {
      fileId = message.document.file_id;
      fileSize = message.document.file_size || 0;
      fileName = message.document.file_name || `tg_${Date.now()}.jpg`;
      if (fileName.includes(".")) {
        fileExt = fileName.split(".").pop().toLowerCase();
      }
      mimeType = message.document.mime_type || mimeMap[fileExt] || "image/jpeg";
    } else if (message.video) {
      fileId = message.video.file_id;
      fileSize = message.video.file_size || 0;
      fileExt = "mp4";
      fileName = message.video.file_name || `tg_${Date.now()}.mp4`;
      mimeType = message.video.mime_type || "video/mp4";
    } else if (message.animation) {
      fileId = message.animation.file_id;
      fileSize = message.animation.file_size || 0;
      fileExt = "gif";
      fileName = message.animation.file_name || `tg_${Date.now()}.gif`;
      mimeType = message.animation.mime_type || "image/gif";
    } else if (message.sticker) {
      fileId = message.sticker.file_id;
      fileSize = message.sticker.file_size || 0;
      fileExt = message.sticker.is_animated ? "tgs" : (message.sticker.is_video ? "webm" : "webp");
      fileName = `sticker_${Date.now()}.${fileExt}`;
      mimeType = mimeMap[fileExt] || "image/webp";
    }

    if (!fileId) {
      if (message.text === "/start") {
        const currentDirInfo = uploadDir ? `\`/${uploadDir}\`` : "`根目录 /`";
        await sendTelegramMessage(
          env.TG_BOT_TOKEN,
          chatId,
          `✅ 图床机器人已连接！\n📁 **当前默认存储目录：** ${currentDirInfo}\n💡 **小贴士：** 发图时在说明文字里写 \`#目录名\`（如 \`#wallpaper\`）可临时存入指定文件夹。`
        );
      }
      return new Response("OK", { status: 200 });
    }

    // 4. 极速转发至存储频道
    const forwardRes = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/forwardMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TG_CHAT_ID,
        from_chat_id: chatId,
        message_id: message.message_id
      })
    });
    const forwardData = await forwardRes.json();

    if (!forwardData.ok) {
      await sendTelegramMessage(env.TG_BOT_TOKEN, chatId, `❌ 转发至存储频道失败：${forwardData.description}`);
      return new Response("OK", { status: 200 });
    }

    // 5. 获取转发后的真实 file_id 与二次确认 file_size
    const savedMsg = forwardData.result;
    let targetFileId = fileId;
    if (savedMsg.photo && savedMsg.photo.length > 0) {
      const p = savedMsg.photo[savedMsg.photo.length - 1];
      targetFileId = p.file_id;
      if (!fileSize && p.file_size) fileSize = p.file_size;
    } else if (savedMsg.document) {
      targetFileId = savedMsg.document.file_id;
      if (!fileSize && savedMsg.document.file_size) fileSize = savedMsg.document.file_size;
    } else if (savedMsg.video) {
      targetFileId = savedMsg.video.file_id;
      if (!fileSize && savedMsg.video.file_size) fileSize = savedMsg.video.file_size;
    } else if (savedMsg.animation) {
      targetFileId = savedMsg.animation.file_id;
      if (!fileSize && savedMsg.animation.file_size) fileSize = savedMsg.animation.file_size;
    } else if (savedMsg.sticker) {
      targetFileId = savedMsg.sticker.file_id;
      if (!fileSize && savedMsg.sticker.file_size) fileSize = savedMsg.sticker.file_size;
    }

    // 关键修改：将文件夹路径拼接到 fileKey 前面（如 "telegram/AgACAgU...jpg"）
    const fileKey = `${uploadDir}${targetFileId}.${fileExt}`;
    const originUrl = new URL(request.url).origin;
    // 对路径中的中文或特殊字符做 URL 编码，保留 "/" 分隔符
    const encodedKey = fileKey.split("/").map(encodeURIComponent).join("/");
    const imageUrl = `${originUrl}/file/${encodedKey}`;

    const sizeInMB = fileSize > 0
      ? Math.max(0.01, Number((fileSize / 1024 / 1024).toFixed(2))).toFixed(2)
      : "0.01";

    const metadata = {
      TimeStamp: Date.now(),
      ListType: "None",
      Label: "None",
      Directory: uploadDir, // 关键修改：同步写入 Directory 字段供后台文件夹视图归类
      liked: false,
      fileName: fileName,
      FileName: fileName,
      fileSize: sizeInMB,
      FileSize: sizeInMB,
      size: fileSize,
      FileType: mimeType,
      mimeType: mimeType,
      ContentType: mimeType,
      UploadIP: "TelegramBot",
      UploadAddress: "Telegram",
      Channel: "TelegramNew",
      ChannelName: "Telegram_env",
      TgFileId: targetFileId,
      TgChatId: String(env.TG_CHAT_ID),
      TgBotToken: String(env.TG_BOT_TOKEN),
      TgMessageId: savedMsg.message_id
    };

    // 6. 写入 KV 单条记录
    if (env.img_url) {
      await env.img_url.put(fileKey, "", { metadata });
    }

    // 7. 同步更新图床后台索引
    const indexStatus = await syncToAdminIndex(context, fileKey, metadata);

    // 8. 秒回直链（展示存入的文件夹路径）
    const folderDisplay = uploadDir ? `/${uploadDir}` : "根目录 /";
    const replyText = `🎉 上传成功！\n\n🔗 **直链：**\n\`${imageUrl}\`\n\n📝 **Markdown：**\n\`![${fileName}](${imageUrl})\`\n\n📁 **目录：** \`${folderDisplay}\` | 📊 **大小：** ${sizeInMB} MB\n🔄 **状态：** ${indexStatus}`;
    await sendTelegramMessage(env.TG_BOT_TOKEN, chatId, replyText);

    return new Response("OK", { status: 200 });
  } catch (err) {
    return new Response(`Error: ${err.message}`, { status: 200 });
  }
}

async function syncToAdminIndex(context, fileKey, metadata) {
  const { env } = context;

  try {
    const indexManager = await import("../utils/indexManager.js");
    if (indexManager.addFileToIndex) {
      await indexManager.addFileToIndex(context, fileKey, metadata);
      return "已通过原生 addFileToIndex 实时入库";
    }
    if (indexManager.rebuildIndex) {
      await indexManager.rebuildIndex(context);
      return "已通过原生 rebuildIndex 重建入库";
    }
  } catch (e) {}

  if (env.img_url) {
    try {
      const indexRaw = await env.img_url.get("manage@index_0") || await env.img_url.get("manage@index");
      if (indexRaw) {
        const parsed = JSON.parse(indexRaw);
        const newEntry = { id: fileKey, name: fileKey, metadata };

        if (Array.isArray(parsed)) {
          parsed.unshift(newEntry);
          await env.img_url.put("manage@index", JSON.stringify(parsed));
          return "已直接追加至 KV 数组索引";
        } else if (parsed && Array.isArray(parsed.files)) {
          parsed.files.unshift(newEntry);
          if (typeof parsed.totalCount === "number") parsed.totalCount += 1;
          await env.img_url.put("manage@index", JSON.stringify(parsed));
          return "已直接追加至 KV 对象索引";
        }
      }

      const opId = `manage@index@operation_${Date.now()}`;
      await env.img_url.put(opId, JSON.stringify({
        type: "add",
        id: fileKey,
        data: { id: fileKey, metadata },
        timestamp: Date.now()
      }));
      return "已写入增量操作队列";
    } catch (kvErr) {
      return `索引写入异常: ${kvErr.message}`;
    }
  }

  return "未找到可用索引引擎";
}

export async function onRequestGet() {
  return new Response("✅ Webhook 接口已正常上线！", {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}

async function sendTelegramMessage(token, chatId, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: "Markdown"
    })
  });
}
