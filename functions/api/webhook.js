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

    // 2. 解析目标存储文件夹
    // 【重要】：优先读取环境变量 TG_UPLOAD_FOLDER；如果环境变量未生效，默认使用 "telegram" 目录（你可直接修改下方双引号内的名字）
    let rawFolder = env.TG_UPLOAD_FOLDER || "telegram";

    // 修复漏洞：仅当【非转发消息】且说明文字明确以 "/dir 目录名" 开头时才允许临时改目录，彻底防止转发别人的 #标签 覆盖默认目录！
    const caption = (message.caption || "").trim();
    const isForwarded = Boolean(message.forward_date || message.forward_from || message.forward_from_chat || message.forward_origin);
    if (!isForwarded && caption.startsWith("/dir ")) {
      rawFolder = caption.slice(5).trim().split(/\s+/)[0];
    }

    // 格式化目录：去除首尾多余斜杠和非法字符，非空时统一以 "/" 结尾（如 "telegram/"）
    const cleanFolder = rawFolder
      .replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, "")
      .replace(/\.\./g, "");
    const uploadDir = cleanFolder ? `${cleanFolder}/` : "";

    // 新增指令：发送 /export 一键导出 Excel(CSV) 表格
    if (message.text && message.text.startsWith("/export") && env.img_url) {
      const filterDir = message.text.replace("/export", "").trim().replace(/^\/+|\/+$/g, "");
      await sendTelegramMessage(env.TG_BOT_TOKEN, chatId, "⏳ 正在为您生成文件明细表格，请稍候...");
      await exportFilesToCSV(env, chatId, new URL(request.url).origin, filterDir);
      return new Response("OK", { status: 200 });
    }

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
      ogg: "audio/ogg",
      pdf: "application/pdf",
      txt: "text/plain; charset=utf-8",
      json: "application/json; charset=utf-8",
      zip: "application/zip",
      rar: "application/vnd.rar",
      "7z": "application/x-7z-compressed",
      apk: "application/vnd.android.package-archive",
      exe: "application/octet-stream",
      ttf: "font/ttf",
      woff: "font/woff",
      woff2: "font/woff2"
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
      mimeType = message.document.mime_type || mimeMap[fileExt] || "application/octet-stream";
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
        const envStatus = env.TG_UPLOAD_FOLDER ? `已读取环境变量 (\`${env.TG_UPLOAD_FOLDER}\`)` : `未检测到环境变量，已启用代码默认目录 (\`${rawFolder}\`)`;
        const currentDirInfo = uploadDir ? `\`/${uploadDir}\`` : "`根目录 /`";
        await sendTelegramMessage(
          env.TG_BOT_TOKEN,
          chatId,
          `✅ 图床机器人已连接！\n📁 **当前生效目录：** ${currentDirInfo}\n⚙️ **目录来源：** ${envStatus}\n\n💡 **使用说明：**\n• 直接发图或转发任何消息：自动存入 \`/${uploadDir}\`\n• 原创发图附带 \`/dir 目录名\`：临时存入指定文件夹\n• 发送 \`/export\`：导出全站文件 CSV 表格`
        );
      }
      return new Response("OK", { status: 200 });
    }

    // 4. 拦截超过 20MB 的文件，防止生成死链
    if (fileSize > 20 * 1024 * 1024) {
      const currentMB = (fileSize / 1024 / 1024).toFixed(2);
      await sendTelegramMessage(
        env.TG_BOT_TOKEN,
        chatId,
        `⚠️ **上传被拦截：文件过大（${currentMB} MB）**\n受限于 Telegram Bot API 官方规则，仅支持生成 **20 MB 以内** 文件的直链。`
      );
      return new Response("OK", { status: 200 });
    }

    // 5. 极速转发至存储频道
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

    // 6. 获取转发后的真实 file_id 与二次确认 file_size
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

    // 将文件夹路径拼接到 fileKey 前面（如 "telegram/AgACAgU...jpg"）
    const fileKey = `${uploadDir}${targetFileId}.${fileExt}`;
    const originUrl = new URL(request.url).origin;
    const encodedKey = fileKey.split("/").map(encodeURIComponent).join("/");
    const imageUrl = `${originUrl}/file/${encodedKey}`;

    const sizeInMB = fileSize > 0
      ? Math.max(0.01, Number((fileSize / 1024 / 1024).toFixed(2))).toFixed(2)
      : "0.01";

    const metadata = {
      TimeStamp: Date.now(),
      ListType: "None",
      Label: "None",
      Directory: uploadDir,
      Folder: cleanFolder,
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

    // 7. 写入 KV 单条记录
    if (env.img_url) {
      await env.img_url.put(fileKey, "", { metadata });
    }

    // 8. 同步更新图床后台索引
    const indexStatus = await syncToAdminIndex(context, fileKey, metadata);

    // 9. 秒回直链（展示存入的文件夹路径）
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

async function exportFilesToCSV(env, chatId, originUrl, filterDir = "") {
  try {
    let allKeys = [];
    let cursor = undefined;

    do {
      const listRes = await env.img_url.list({ cursor, limit: 1000 });
      allKeys.push(...listRes.keys);
      cursor = listRes.list_complete ? undefined : listRes.cursor;
    } while (cursor);

    const validFiles = allKeys.filter(k =>
      !k.name.startsWith("manage@") &&
      !k.name.startsWith("chunk_") &&
      k.metadata &&
      (!filterDir || k.name.startsWith(`${filterDir}/`) || (k.metadata.Directory && k.metadata.Directory.startsWith(filterDir)))
    );

    if (validFiles.length === 0) {
      await sendTelegramMessage(env.TG_BOT_TOKEN, chatId, "📭 未找到符合条件的文件记录。");
      return;
    }

    const headers = ["文件名", "存储目录", "大小(MB)", "MIME类型", "上传渠道", "上传时间", "永久直链", "Markdown代码"];
    const rows = [headers.join(",")];

    for (const item of validFiles) {
      const m = item.metadata || {};
      const fileName = (m.fileName || m.FileName || item.name).replace(/"/g, '""');
      const dir = m.Directory || (item.name.includes("/") ? item.name.substring(0, item.name.lastIndexOf("/") + 1) : "/");
      const size = m.fileSize || m.FileSize || "0.01";
      const type = m.FileType || m.mimeType || "unknown";
      const channel = m.Channel || "Telegram";
      const timeStr = m.TimeStamp ? new Date(Number(m.TimeStamp)).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "";

      const encodedKey = item.name.split("/").map(encodeURIComponent).join("/");
      const url = `${originUrl}/file/${encodedKey}`;
      const md = `![${fileName}](${url})`.replace(/"/g, '""');

      rows.push([
        `"${fileName}"`,
        `"${dir}"`,
        `"${size}"`,
        `"${type}"`,
        `"${channel}"`,
        `"${timeStr}"`,
        `"${url}"`,
        `"${md}"`
      ].join(","));
    }

    const csvContent = "\uFEFF" + rows.join("\r\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8" });

    const formData = new FormData();
    const dateTag = new Date().toISOString().slice(0, 10);
    const csvFileName = filterDir ? `imgbed_${filterDir}_${dateTag}.csv` : `imgbed_all_${dateTag}.csv`;

    formData.append("chat_id", String(chatId));
    formData.append("document", new File([blob], csvFileName, { type: "text/csv" }));
    formData.append("caption", `📊 **图床文件导出完成**\n共导出 **${validFiles.length}** 条文件记录（可直接用 Excel / WPS 打开）。`);
    formData.append("parse_mode", "Markdown");

    await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendDocument`, {
      method: "POST",
      body: formData
    });
  } catch (err) {
    await sendTelegramMessage(env.TG_BOT_TOKEN, chatId, `❌ 导出表格失败：${err.message}`);
  }
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
