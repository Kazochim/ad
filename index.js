// index.js
require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  ChannelType,
  PermissionsBitField,
  EmbedBuilder
} = require('discord.js');

const express = require('express');
const PayOSModule = require('@payos/node');
const PayOS = PayOSModule.PayOS || PayOSModule;
const PRODUCTS = require('./products');

// ====== CONFIG / BIẾN MÔI TRƯỜNG ======
const {
  DISCORD_TOKEN,
  PREFIX,
  GUILD_ID,
  TICKET_CATEGORY_ID,
  STAFF_ROLE_ID,
  VOUCH_CHANNEL_ID,
  PRICE_CHANNEL_ID,
  LOG_CHANNEL_ID,
  PAY_CLIENT_ID,
  PAY_API_KEY,
  PAY_CHECKSUM_KEY,
  WEBHOOK_PORT,
  WEBHOOK_PATH
} = process.env;

// ====== PAYOS INIT ======
const payOS = new PayOS({
  clientId: PAY_CLIENT_ID,
  apiKey: PAY_API_KEY,
  checksumKey: PAY_CHECKSUM_KEY
});

// Map lưu orderCode -> info đơn hàng (demo: lưu trong RAM)
const orders = new Map();

// ====== DISCORD CLIENT ======
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message]
});

client.once('ready', () => {
  console.log(`Đã đăng nhập thành ${client.user.tag}`);
});

// ====== HỖ TRỢ: Lấy kênh log / vouch ======
function getLogChannel() {
  return client.channels.cache.get(LOG_CHANNEL_ID);
}

function getVouchChannel() {
  return client.channels.cache.get(VOUCH_CHANNEL_ID);
}

// ====== HỖ TRỢ: Tạo ticket ======
async function createTicketChannel(message, productKey) {
  const guild = await client.guilds.fetch(GUILD_ID);
  const member = await guild.members.fetch(message.author.id);

  const product = PRODUCTS[productKey];
  if (!product) {
    await message.reply('❌ Sản phẩm không tồn tại. Dùng `!price` để xem danh sách.');
    return;
  }

  const channelName = `ticket-${message.author.username}`.toLowerCase().replace(/[^a-z0-9-]/g, '');
  const ticketChannel = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: TICKET_CATEGORY_ID || null,
    permissionOverwrites: [
      {
        id: guild.roles.everyone,
        deny: [PermissionsBitField.Flags.ViewChannel]
      },
      {
        id: member.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory
        ]
      },
      {
        id: STAFF_ROLE_ID,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory
        ]
      }
    ]
  });

  // Tạo orderCode dựa trên timestamp (demo)
  const orderCode = Date.now();

  // Tạo link thanh toán qua PayOS
  const paymentData = {
    orderCode,
    amount: product.price,
    description: `Thanh toán đơn hàng ${product.name}`,
    returnUrl: `${process.env.BASE_URL || 'https://example.com'}/payos-return`,
    cancelUrl: `${process.env.BASE_URL || 'https://example.com'}/payos-cancel`,
    items: [
      {
        name: product.name,
        quantity: 1,
        price: product.price
      }
    ]
  };

  let paymentLink;
  try {
    paymentLink = await payOS.paymentRequests.create(paymentData);
  } catch (err) {
    console.error('Lỗi tạo link PayOS:', err);
    await ticketChannel.send('❌ Lỗi tạo link thanh toán, liên hệ admin giúp bạn xử lý.');
    return;
  }

  // Lưu đơn hàng vào Map
  orders.set(orderCode, {
    userId: member.id,
    channelId: ticketChannel.id,
    productKey,
    amount: product.price,
    status: 'pending'
  });

  const embed = new EmbedBuilder()
    .setTitle('🎫 Ticket mới')
    .setDescription(
      `Xin chào ${member}!\n\n` +
      `**Sản phẩm:** ${product.name}\n` +
      `**Giá:** ${product.price.toLocaleString('vi-VN')}đ\n\n` +
      `Vui lòng thanh toán qua link dưới đây:`
    )
    .addFields(
      { name: 'Order code', value: String(orderCode), inline: true },
      { name: 'Mô tả', value: product.description || 'Không có', inline: false },
      { name: 'Trạng thái', value: '⏳ Chờ thanh toán', inline: true }
    )
    .setFooter({ text: 'Sau khi thanh toán xong bot sẽ tự động xử lý đơn.' })
    .setTimestamp();

  await ticketChannel.send({
    content: `<@${member.id}> <@&${STAFF_ROLE_ID}>`,
    embeds: [embed]
  });

  await ticketChannel.send(`🔗 Link thanh toán: ${paymentLink.checkoutUrl}`);

  await message.reply(`✅ Ticket đã tạo: ${ticketChannel}`);
}

// ====== COMMAND HANDLER ======
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = args.shift()?.toLowerCase();

  try {
    switch (cmd) {
      case 'ticket': {
        // !ticket <productId>
        const productKey = args[0];
        if (!productKey) {
          await message.reply('❌ Dùng: `!ticket <productId>` – xem productId trong `!price`.');
          return;
        }
        await createTicketChannel(message, productKey);
        break;
      }

      case 'claim': {
        // chỉ staff dùng trong kênh ticket
        if (!message.member.roles.cache.has(STAFF_ROLE_ID)) {
          await message.reply('❌ Bạn không có quyền claim.');
          return;
        }
        await message.channel.send(`👨‍💼 Ticket này đã được claim bởi ${message.member}.`);
        break;
      }

      case 'confirm': {
        // !confirm <orderCode>
        if (!message.member.roles.cache.has(STAFF_ROLE_ID)) {
          await message.reply('❌ Bạn không có quyền confirm.');
          return;
        }
        const orderCode = Number(args[0]);
        if (!orderCode || !orders.has(orderCode)) {
          await message.reply('❌ Order code không hợp lệ.');
          return;
        }
        const order = orders.get(orderCode);
        order.status = 'confirmed';
        orders.set(orderCode, order);

        const user = await message.guild.members.fetch(order.userId).catch(() => null);
        if (user) {
          await message.channel.send(
            `✅ Đơn hàng **${orderCode}** đã được **CONFIRM**.\n` +
            `Khách hàng: ${user}\n` +
            `Sản phẩm: **${PRODUCTS[order.productKey].name}**\n` +
            `Cảm ơn bạn đã mua hàng! Hãy để lại \`!vouch <đánh giá>\` giúp shop nhé.`
          );
        }

        const logChannel = getLogChannel();
        if (logChannel) {
          await logChannel.send(
            `🧾 **CONFIRM** bởi ${message.member} | Order: **${orderCode}** | User: <@${order.userId}>`
          );
        }
        break;
      }

      case 'done': {
        // đóng ticket
        if (!message.member.roles.cache.has(STAFF_ROLE_ID)) {
          await message.reply('❌ Bạn không có quyền dùng lệnh này.');
          return;
        }
        await message.channel.send('✅ Ticket sẽ được đóng sau 5 giây...');
        setTimeout(() => {
          message.channel.delete().catch(() => {});
        }, 5000);
        break;
      }

      case 'vouch': {
        // !vouch <nội dung>
        const content = args.join(' ');
        if (!content) {
          await message.reply('❌ Dùng: `!vouch <nội dung>`');
          return;
        }
        const vouchChannel = getVouchChannel();
        if (!vouchChannel) {
          await message.reply('❌ Chưa cấu hình kênh vouch.');
          return;
        }

        const embed = new EmbedBuilder()
          .setTitle('⭐ VOUCH MỚI')
          .setDescription(content)
          .addFields({ name: 'Từ', value: `${message.author.tag} (${message.author.id})` })
          .setTimestamp();

        const msg = await vouchChannel.send({ embeds: [embed] });
        await msg.react('⭐');

        await message.reply('✅ Cảm ơn vì feedback của bạn!');
        break;
      }

      case 'price': {
        // gửi bảng giá
        const embed = new EmbedBuilder()
          .setTitle('📋 BẢNG GIÁ SẢN PHẨM')
          .setDescription('Dùng lệnh `!ticket <productId>` để mua.')
          .setTimestamp();

        Object.values(PRODUCTS).forEach((p) => {
          embed.addFields({
            name: `${p.name} — **${p.price.toLocaleString('vi-VN')}đ**`,
            value: `ID: \`${p.id}\`\n${p.description || 'Không có mô tả.'}`
          });
        });

        await message.channel.send({ embeds: [embed] });
        break;
      }

      case 'qr': {
        // !qr <orderCode> – chỉ đơn giản gửi lại link thanh toán (nếu muốn bạn có thể dựng QR riêng)
        const orderCode = Number(args[0]);
        if (!orderCode || !orders.has(orderCode)) {
          await message.reply('❌ Order code không hợp lệ.');
          return;
        }
        const order = orders.get(orderCode);
        await message.reply(
          '⚠️ Ở demo này mình không lưu lại checkoutUrl.\n' +
          'Bạn có thể lưu thêm `checkoutUrl` trong object `order` ở đoạn tạo đơn và gửi lại cho khách tại đây.'
        );
        break;
      }

      default: {
        // optional: help
        if (cmd === 'help' || cmd === 'store') {
          await message.reply(
            [
              '**Danh sách lệnh Store:**',
              '`!price` – xem bảng giá',
              '`!ticket <productId>` – mở ticket mua hàng',
              '`!claim` – staff claim ticket',
              '`!confirm <orderCode>` – staff confirm đơn',
              '`!done` – đóng ticket',
              '`!vouch <nội dung>` – gửi đánh giá'
            ].join('\n')
          );
        }
      }
    }
  } catch (err) {
    console.error(err);
    await message.reply('❌ Có lỗi xảy ra khi xử lý lệnh.');
  }
});

// ====== EXPRESS WEBHOOK PAYOS ======
const app = express();
app.use(express.json());

// Webhook PayOS: gửi từ my.payos.vn về
app.post(process.env.WEBHOOK_PATH || '/payos-webhook', async (req, res) => {
  try {
    // Xác minh dữ liệu webhook từ PayOS
    const webhookData = await payOS.webhooks.verify(req.body);
    const orderCode = webhookData.orderCode || webhookData.order_code;

    console.log('Webhook PayOS:', webhookData);

    if (!orderCode || !orders.has(orderCode)) {
      console.warn('Không tìm thấy order cho orderCode:', orderCode);
      return res.status(200).json({ message: 'OK (no order found)' });
    }

    const order = orders.get(orderCode);
    order.status = 'paid';
    orders.set(orderCode, order);

    // Tìm kênh ticket & user
    const channel = client.channels.cache.get(order.channelId);
    if (channel) {
      await channel.send(
        `💰 **PAYOS** báo thanh toán thành công cho order **${orderCode}**\n` +
        `Sản phẩm: **${PRODUCTS[order.productKey].name}**\n` +
        `Số tiền: **${order.amount.toLocaleString('vi-VN')}đ**\n\n` +
        `Staff vui lòng kiểm tra và dùng \`!confirm ${orderCode}\` sau khi giao hàng cho khách.`
      );

      // ====== AUTO BUY (GỬI HÀNG TỰ ĐỘNG) – DEMO ======
      // Ở đây bạn có thể:
      // - Đọc data từ file / DB (list account / key)
      // - Gửi trực tiếp qua DM hoặc gửi trong kênh ticket.
      try {
        const guild = await client.guilds.fetch(GUILD_ID);
        const member = await guild.members.fetch(order.userId);

        // TODO: thay bằng data thật, ví dụ lấy tài khoản từ DB
        const fakeItem = 'user: demo@example.com | pass: 123456';

        await member.send(
          `🛒 Đơn hàng **${orderCode}** đã thanh toán thành công.\n` +
          `Sản phẩm: **${PRODUCTS[order.productKey].name}**\n` +
          `Dưới đây là thông tin sản phẩm của bạn:\n\`\`\`${fakeItem}\`\`\`\n` +
          `Cảm ơn bạn đã mua hàng tại shop!`
        );

        await channel.send('📦 Hàng đã được gửi tự động qua DM cho khách.');
      } catch (e) {
        console.error('Lỗi gửi hàng auto buy:', e);
        await channel.send('⚠️ Auto gửi hàng lỗi, staff vui lòng gửi tay.');
      }
    }

    res.status(200).json({ message: 'OK' });
  } catch (err) {
    console.error('Lỗi webhook PayOS:', err);
    res.status(400).json({ message: 'Invalid webhook' });
  }
});

const port = Number(WEBHOOK_PORT) || 3000;
app.listen(port, () => {
  console.log(`Webhook server chạy ở cổng ${port}`);
});

// ====== RUN BOT ======
client.login(DISCORD_TOKEN);


