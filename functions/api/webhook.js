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

    // 2. 提取图片或文件信息（零内存占用）
    let fileId = null;
    let fileExt = "jpg";
    let fileName = `tg_${Date.now()}.jpg`;
    let fileSize = 0;

    if (message.photo && message.photo.length > 0) {
      const largestPhoto = message.photo[message.photo.length - 1];
      fileId = largestPhoto.file_id;
      fileSize = largestPhoto.file_size || 0;
      fileName = `tg_${Date.now()}.jpg`;
    } else if (message.document) {
      fileId = message.document.file_id;
      fileSize = message.document.file_size || 0;
      fileName = message.document.file_name || `tg_${Date.now()}`;
      if (fileName.includes(".")) {
        fileExt = fileName.split(".").pop().toLowerCase();
      }
    } else if (message.video) {
      fileId = message.video.file_id;
      fileSize = message.video.file_size || 0;
      fileExt = "mp4";
      fileName = message.video.file_name || `tg_${Date.now()}.mp4`;
    } else if (message.animation) {
      fileId = message.animation.file_id;
      fileSize = message.animation.file_size || 0;
      fileExt = "gif";
      fileName = message.animation.file_name || `tg_${Date.now()}.gif`;
    }

    if (!fileId) {
      if (message.text === "/start") {
        await sendTelegramMessage(env.TG_BOT_TOKEN, chatId, "✅ 图床机器人已连接（原生索引直写模式）！直接发送图片即可秒回外链并实时同步后台。");
      }
      return new Response("OK", { status: 200 });
    }

    // 3. 极速转发至存储频道
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

    // 4. 获取转发后的真实 file_id
    const savedMsg = forwardData.result;
    let targetFileId = fileId;
    if (savedMsg.photo && savedMsg.photo.length > 0) {
      targetFileId = savedMsg.photo[savedMsg.photo.length - 1].file_id;
    } else if (savedMsg.document) {
      targetFileId = savedMsg.document.file_id;
    } else if (savedMsg.video) {
      targetFileId = savedMsg.video.file_id;
    } else if (savedMsg.animation) {
      targetFileId = savedMsg.animation.file_id;
    }

    const fileKey = `${targetFileId}.${fileExt}`;
    const originUrl = new URL(request.url).origin;
    const imageUrl = `${originUrl}/file/${fileKey}`;

    const metadata = {
      TimeStamp: Date.now(),
      ListType: "None",
      Label: "None",
      Directory: "",
      liked: false,
      fileName: fileName,
      fileSize: Number((fileSize / 1024 / 1024).toFixed(2)),
      UploadIP: "TelegramBot",
      UploadAddress: "Telegram",
      Channel: "TelegramNew",
      ChannelName: "Telegram_env",
      TgFileId: targetFileId,
      TgChatId: String(env.TG_CHAT_ID),
      TgBotToken: String(env.TG_BOT_TOKEN),
      TgMessageId: savedMsg.message_id
    };

    // 5. 写入 KV 单条记录
    if (env.img_url) {
      await env.img_url.put(fileKey, "", { metadata });
    }

    // 6. 核心步骤：直接同步更新图床后台索引（无需手动点重建按钮）
    const indexStatus = await syncToAdminIndex(context, fileKey, metadata);

    // 7. 秒回直链
    const replyText = `🎉 上传成功！\n\n🔗 **直链：**\n\`${imageUrl}\`\n\n📝 **Markdown：**\n\`![${fileName}](${imageUrl})\`\n\n🔄 **索引状态：** ${indexStatus}`;
    await sendTelegramMessage(env.TG_BOT_TOKEN, chatId, replyText);

    return new Response("OK", { status: 200 });
  } catch (err) {
    return new Response(`Error: ${err.message}`, { status: 200 });
  }
}

// 内部索引同步函数：优先调用项目原生 indexManager，兜底直接更新 KV 中的索引键
async function syncToAdminIndex(context, fileKey, metadata) {
  const { env } = context;

  // 方式 A：直接调用 CloudFlare-ImgBed 内置的 indexManager 工具函数
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
  } catch (e) {
    // 如果项目目录结构不同，自动降级到方式 B
  }

  // 方式 B：直接读取并更新 KV 里的 manage@index / manage@index_0
  if (env.img_url) {
    try {
      // 检查是否存在分片索引或主索引
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

      // 若使用的是原子操作队列（manage@index@operation_*），写入一条新增操作指令
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
