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

    // 2. 提取图片或文件信息
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
        const dbStatus = `KV(img_url): ${env.img_url ? "✅已绑定" : "❌未绑定"} | D1(DB): ${env.DB ? "✅已绑定" : "❌未绑定"}`;
        await sendTelegramMessage(env.TG_BOT_TOKEN, chatId, `✅ 图床机器人已连接！\n当前数据库状态：${dbStatus}`);
      }
      return new Response("OK", { status: 200 });
    }

    // 3. 转发至存储频道
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

    // 4. 获取转发后的真实 file_id 和 message_id
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

    // 构造全兼容 Metadata（覆盖新旧版本所有字段）
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

    let syncLog = [];

    // 5A. 写入 KV 并清理可能存在的目录索引缓存
    if (env.img_url) {
      try {
        await env.img_url.put(fileKey, "", { metadata });
        // 尝试清理新版 CloudFlare-ImgBed 的目录列表缓存键（如有）
        await env.img_url.delete("manage@index");
        await env.img_url.delete("manage@index_0");
        syncLog.push("KV写入成功");
      } catch (kvErr) {
        syncLog.push(`KV报错: ${kvErr.message}`);
      }
    } else {
      syncLog.push("未检测到 img_url 绑定");
    }

    // 5B. 写入 D1 数据库（自动探测表结构）
    if (env.DB) {
      try {
        await env.DB.prepare(
          "INSERT OR REPLACE INTO img_info (url, value, metadata) VALUES (?, ?, ?)"
        ).bind(fileKey, "", JSON.stringify(metadata)).run();
        syncLog.push("D1(img_info)写入成功");
      } catch (e1) {
        try {
          await env.DB.prepare(
            "INSERT OR REPLACE INTO files (id, value, metadata) VALUES (?, ?, ?)"
          ).bind(fileKey, "", JSON.stringify(metadata)).run();
          syncLog.push("D1(files)写入成功");
        } catch (e2) {
          syncLog.push(`D1报错: ${e2.message}`);
        }
      }
    }

    // 6. 回复结果与诊断状态
    const replyText = `🎉 上传成功！\n\n🔗 **直链：**\n\`${imageUrl}\`\n\n📝 **Markdown：**\n\`![${fileName}](${imageUrl})\`\n\n📊 **后台同步状态：** ${syncLog.join(" | ")}`;
    await sendTelegramMessage(env.TG_BOT_TOKEN, chatId, replyText);

    return new Response("OK", { status: 200 });
  } catch (err) {
    return new Response(`Error: ${err.message}`, { status: 200 });
  }
}

export async function onRequestGet() {
  return new Response("✅ Webhook 接口已正常上线！请直接在 Telegram 私聊机器人发送图片测试。", {
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
