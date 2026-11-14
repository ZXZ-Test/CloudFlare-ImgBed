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

    // 2. 提取图片或文件的 file_id
    let fileId = null;
    let fileExt = "jpg";

    if (message.photo && message.photo.length > 0) {
      // 取最高清晰度的照片
      fileId = message.photo[message.photo.length - 1].file_id;
    } else if (message.document) {
      fileId = message.document.file_id;
      const fileName = message.document.file_name || "";
      if (fileName.includes(".")) {
        fileExt = fileName.split(".").pop();
      }
    }

    // 如果发送的是 /start 等纯文本指令，返回提示
    if (!fileId) {
      if (message.text === "/start") {
        await sendTelegramMessage(env.TG_BOT_TOKEN, chatId, "✅ 图床机器人已连接！直接发送图片或文件即可生成永久外链。");
      }
      return new Response("OK", { status: 200 });
    }

    // 3. 将图片转发到你的私有存储频道（确保文件永久保存）
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

    // 4. 提取转发后的文件标识并拼接图床直链
    const savedMsg = forwardData.result;
    let targetFileId = fileId;
    if (savedMsg.photo) {
      targetFileId = savedMsg.photo[savedMsg.photo.length - 1].file_id;
    } else if (savedMsg.document) {
      targetFileId = savedMsg.document.file_id;
    }

    const originUrl = new URL(request.url).origin;
    const imageUrl = `${originUrl}/file/${targetFileId}.${fileExt}`;

    // 5. 写入 KV 数据库（如果绑定了 img_url，使其能在 /admin 后台显示）
    if (env.img_url) {
      await env.img_url.put(`${targetFileId}.${fileExt}`, JSON.stringify({
        TimeStamp: Date.now(),
        ListType: "None",
        Label: "None"
      }));
    }

    // 6. 回复用户生成的直链和 Markdown 格式
    const replyText = `🎉 上传成功！\n\n**直链：**\n\`${imageUrl}\`\n\n**Markdown：**\n\`![image](${imageUrl})\``;
    await sendTelegramMessage(env.TG_BOT_TOKEN, chatId, replyText);

    return new Response("OK", { status: 200 });
  } catch (err) {
    return new Response(`Error: ${err.message}`, { status: 200 });
  }
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
