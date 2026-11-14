export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const update = await request.json();
    const message = update.message || update.channel_post;
    if (!message) return new Response("OK", { status: 200 });

    const chatId = message.chat.id;
    const userId = message.from ? message.from.id : null;

    // 1. 权限校验：如果配置了 ALLOWED_USERS，仅允许白名单用户触发
    if (env.ALLOWED_USERS) {
      const allowedList = env.ALLOWED_USERS.split(",").map(id => id.trim());
      if (userId && !allowedList.includes(String(userId))) {
        return new Response("Unauthorized user", { status: 200 });
      }
    }

    // 2. 提取图片或文件的 file_id、文件名与大小
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

    // 如果发送的是 /start 等纯文本指令，返回提示
    if (!fileId) {
      if (message.text === "/start") {
        await sendTelegramMessage(env.TG_BOT_TOKEN, chatId, "✅ 图床机器人已连接！直接发送图片或文件即可生成永久外链，并自动同步至图床后台。");
      }
      return new Response("OK", { status: 200 });
    }

    // 3. 将图片转发到你的私有存储频道
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

    // 4. 提取转发后频道消息中的实际 file_id
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

    // 构造 CloudFlare-ImgBed 后台管理所需的完整元数据
    const metadata = {
      TimeStamp: Date.now(),
      ListType: "None",
      Label: "None",
      liked: false,
      fileName: fileName,
      fileSize: (fileSize / 1024 / 1024).toFixed(2),
      Channel: "TelegramNew",
      ChannelName: "Telegram Bot",
      TgFileId: targetFileId,
      TgChatId: String(env.TG_CHAT_ID),
      TgBotToken: String(env.TG_BOT_TOKEN)
    };

    // 5A. 写入 KV 数据库（必须写入 metadata 参数，后台列表才能读取到）
    if (env.img_url) {
      await env.img_url.put(fileKey, "", { metadata });
    }

    // 5B. 兼容 D1 数据库（如果你在 Cloudflare 绑定的是 D1 数据库 DB）
    if (env.DB) {
      try {
        await env.DB.prepare(
          "INSERT OR REPLACE INTO files (id, value, metadata) VALUES (?, ?, ?)"
        ).bind(fileKey, "", JSON.stringify(metadata)).run();
      } catch (dbErr) {
        console.error("D1 insert error:", dbErr);
      }
    }

    // 6. 回复用户生成的直链和 Markdown 格式
    const replyText = `🎉 上传成功！\n\n**直链：**\n\`${imageUrl}\`\n\n**Markdown：**\n\`![${fileName}](${imageUrl})\``;
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
