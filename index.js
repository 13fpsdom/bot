require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  MessageFlags,
} = require('discord.js');

const { MY_BOT_TOKEN, GUILD_ID, STAFF_ROLE_ID, TICKET_CATEGORY_ID, LOG_CHANNEL_ID } = process.env;

if (!MY_BOT_TOKEN) {
  console.error("Missing MY_BOT_TOKEN environment variable. Set it in your host's Environment settings or in your .env file.");
  process.exit(1);
}
if (!GUILD_ID) {
  console.error("Missing GUILD_ID environment variable. Set it to your server ID in your host's Environment settings or in your .env file.");
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ---------------------------------------------------------------
// Simple JSON storage (blacklist)
// NOTE: on hosts with an ephemeral disk (e.g. Render without a Disk)
// this file is wiped on every redeploy/restart.
// ---------------------------------------------------------------
const DATA_FILE = path.join(__dirname, 'data.json');
let data = { blacklist: {} };
try {
  data = { blacklist: {}, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
} catch {
  /* first run - no file yet */
}
function saveData() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Could not save data.json:', err);
  }
}

// ---------------------------------------------------------------
// Ticket types - edit questions / price here
// ---------------------------------------------------------------
const SHORT = TextInputStyle.Short;
const LONG = TextInputStyle.Paragraph;

const TICKET_TYPES = {
  building: {
    label: 'Building Services',
    emoji: '🏗️',
    prefix: 'build',
    color: 0x3498db,
    fields: [
      { id: 'ign', label: 'What is your IGN?', style: SHORT },
      { id: 'build', label: 'What build would you like?', style: LONG },
    ],
    notice: '💰 **Payment:** Please pay **2341k** for the build.',
  },
  support: {
    label: 'Support / Giveaway Claims',
    emoji: '🎁',
    prefix: 'support',
    color: 0x2ecc71,
    fields: [
      { id: 'ign', label: 'What is your IGN?', style: SHORT },
      { id: 'issue', label: 'What is your issue?', style: LONG },
    ],
    notice: null,
  },
  skeleton: {
    label: 'Skeleton Sell/Buys',
    emoji: '💀',
    prefix: 'skeleton',
    color: 0xe67e22,
    fields: [
      { id: 'ign', label: 'What is your IGN?', style: SHORT },
      { id: 'amount', label: 'How many skellys would you like?', style: SHORT },
      { id: 'action', label: 'Are you selling / buying?', style: SHORT },
    ],
    notice: null,
  },
};

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
const eph = (content) => ({ content, flags: MessageFlags.Ephemeral });

const isStaff = (member) =>
  Boolean(
    (STAFF_ROLE_ID && member.roles.cache.has(STAFF_ROLE_ID)) ||
      member.permissions.has(PermissionFlagsBits.ManageChannels)
  );

// Ticket info is stored in the channel topic:
//   ticket-owner:<userId>            or   ticket-owner:<userId>|claimed:<staffId>
function parseTicket(channel) {
  const m = /^ticket-owner:(\d+)(?:\|claimed:(\d+))?$/.exec(channel.topic || '');
  return m ? { ownerId: m[1], claimedBy: m[2] || null } : null;
}
function setTicketTopic(channel, ownerId, claimedBy) {
  return channel.setTopic(`ticket-owner:${ownerId}${claimedBy ? `|claimed:${claimedBy}` : ''}`);
}

async function sendLog(guild, embed) {
  if (!LOG_CHANNEL_ID) return;
  try {
    const ch = await guild.channels.fetch(LOG_CHANNEL_ID);
    if (ch) await ch.send({ embeds: [embed] });
  } catch (err) {
    console.error('Could not send to log channel:', err.message);
  }
}

async function closeTicket(interaction, reason) {
  const channel = interaction.channel;
  const info = parseTicket(channel);
  const finalReason = reason || 'No reason provided';

  await interaction.reply(`🔒 Ticket closed by ${interaction.user}. Deleting in 5 seconds...\n**Reason:** ${finalReason}`);

  await sendLog(
    interaction.guild,
    new EmbedBuilder()
      .setTitle('🔒 Ticket Closed')
      .setColor(0xe74c3c)
      .addFields(
        { name: 'Ticket', value: `#${channel.name}`, inline: true },
        { name: 'Opened by', value: info ? `<@${info.ownerId}>` : 'Unknown', inline: true },
        { name: 'Claimed by', value: info?.claimedBy ? `<@${info.claimedBy}>` : 'Nobody', inline: true },
        { name: 'Closed by', value: `${interaction.user}`, inline: true },
        { name: 'Reason', value: finalReason }
      )
      .setTimestamp()
  );

  if (info) {
    client.users
      .fetch(info.ownerId)
      .then((u) => u.send(`Your ticket **#${channel.name}** in **${interaction.guild.name}** was closed.\nReason: ${finalReason}`))
      .catch(() => {});
  }

  setTimeout(() => channel.delete(`Closed by ${interaction.user.tag}`).catch(console.error), 5000);
}

async function claimTicket(interaction) {
  const info = parseTicket(interaction.channel);
  if (info.claimedBy === interaction.user.id) {
    return interaction.reply(eph('You have already claimed this ticket.'));
  }
  if (info.claimedBy) {
    return interaction.reply(eph(`This ticket is already claimed by <@${info.claimedBy}>. They can use /unclaim first.`));
  }
  await setTicketTopic(interaction.channel, info.ownerId, interaction.user.id);
  return interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setColor(0x57f287)
        .setDescription(`🙋 ${interaction.user} has claimed this ticket and will be helping you.`),
    ],
  });
}

// ---------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------
const commands = [
  new SlashCommandBuilder()
    .setName('ticketpanel')
    .setDescription('Post the ticket panel in this channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName('close')
    .setDescription('Close this ticket')
    .addStringOption((o) => o.setName('reason').setDescription('Reason for closing')),

  new SlashCommandBuilder()
    .setName('rename')
    .setDescription('Rename this ticket channel')
    .addStringOption((o) => o.setName('name').setDescription('New channel name').setRequired(true)),

  new SlashCommandBuilder().setName('claim').setDescription('Claim this ticket'),
  new SlashCommandBuilder().setName('unclaim').setDescription('Release your claim on this ticket'),

  new SlashCommandBuilder()
    .setName('add')
    .setDescription('Add a user to this ticket')
    .addUserOption((o) => o.setName('user').setDescription('User to add').setRequired(true)),

  new SlashCommandBuilder()
    .setName('remove')
    .setDescription('Remove a user from this ticket')
    .addUserOption((o) => o.setName('user').setDescription('User to remove').setRequired(true)),

  new SlashCommandBuilder()
    .setName('blacklist')
    .setDescription('Manage who is blocked from opening tickets')
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Blacklist a user from opening tickets')
        .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Reason'))
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Remove a user from the blacklist')
        .addUserOption((o) => o.setName('user').setDescription('User').setRequired(true))
    )
    .addSubcommand((s) => s.setName('list').setDescription('Show all blacklisted users')),
].map((c) => c.toJSON());

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    const guild = await client.guilds.fetch(GUILD_ID.trim());
    await guild.commands.set(commands);
    console.log('Slash commands registered.');
  } catch (err) {
    console.error(
      'Could not register slash commands. Check that GUILD_ID is correct and the bot has been invited to that server.',
      err
    );
  }
});

async function handleCommand(interaction) {
  const name = interaction.commandName;

  // /ticketpanel
  if (name === 'ticketpanel') {
    const embed = new EmbedBuilder()
      .setTitle('🎫 Open a Ticket')
      .setDescription(
        'Use the dropdown below to open a ticket.\n\n' +
          Object.values(TICKET_TYPES)
            .map((t) => `${t.emoji} **${t.label}**`)
            .join('\n')
      )
      .setColor(0x5865f2);

    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('ticket_select')
        .setPlaceholder('Select a ticket type...')
        .addOptions(
          Object.entries(TICKET_TYPES).map(([key, t]) => ({
            label: t.label,
            value: key,
            emoji: t.emoji,
          }))
        )
    );

    await interaction.channel.send({ embeds: [embed], components: [row] });
    return interaction.reply(eph('Panel posted ✅'));
  }

  // Everything below is staff only
  if (!isStaff(interaction.member)) {
    return interaction.reply(eph("You don't have permission to use this command."));
  }

  // /blacklist (works anywhere)
  if (name === 'blacklist') {
    const sub = interaction.options.getSubcommand();

    if (sub === 'add') {
      const user = interaction.options.getUser('user');
      const reason = interaction.options.getString('reason') || 'No reason provided';
      if (user.bot) return interaction.reply(eph("You can't blacklist a bot."));
      data.blacklist[user.id] = { reason, by: interaction.user.id, at: Date.now() };
      saveData();
      return interaction.reply(eph(`🚫 ${user} has been blacklisted from opening tickets.\n**Reason:** ${reason}`));
    }

    if (sub === 'remove') {
      const user = interaction.options.getUser('user');
      if (!data.blacklist[user.id]) return interaction.reply(eph(`${user} is not blacklisted.`));
      delete data.blacklist[user.id];
      saveData();
      return interaction.reply(eph(`✅ ${user} has been removed from the blacklist.`));
    }

    if (sub === 'list') {
      const entries = Object.entries(data.blacklist);
      if (!entries.length) return interaction.reply(eph('The blacklist is empty.'));
      const lines = entries
        .slice(0, 25)
        .map(([id, b]) => `<@${id}> — ${b.reason} (by <@${b.by}>)`)
        .join('\n');
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle(`🚫 Blacklist (${entries.length})`)
            .setDescription(lines.slice(0, 4000))
            .setColor(0xe74c3c),
        ],
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  // Ticket-only commands
  const info = parseTicket(interaction.channel);
  if (!info) {
    return interaction.reply(eph('This command can only be used inside a ticket channel.'));
  }

  if (name === 'close') {
    return closeTicket(interaction, interaction.options.getString('reason'));
  }

  if (name === 'claim') return claimTicket(interaction);

  if (name === 'unclaim') {
    if (!info.claimedBy) return interaction.reply(eph('This ticket is not claimed.'));
    if (info.claimedBy !== interaction.user.id && !interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
      return interaction.reply(eph(`Only <@${info.claimedBy}> (or someone with Manage Channels) can unclaim this ticket.`));
    }
    await setTicketTopic(interaction.channel, info.ownerId, null);
    return interaction.reply(`🔓 ${interaction.user} has unclaimed this ticket.`);
  }

  if (name === 'rename') {
    const clean = interaction.options
      .getString('name')
      .toLowerCase()
      .replace(/[^a-z0-9-_ ]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 90);
    if (!clean) return interaction.reply(eph('That name is not valid.'));
    await interaction.deferReply(); // channel renames are rate limited, so don't time out
    await interaction.channel.setName(clean);
    return interaction.editReply(`✏️ Ticket renamed to **#${clean}**.`);
  }

  if (name === 'add') {
    const user = interaction.options.getUser('user');
    if (user.bot) return interaction.reply(eph("You can't add a bot to a ticket."));
    await interaction.channel.permissionOverwrites.edit(user.id, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      AttachFiles: true,
    });
    return interaction.reply(`➕ ${user} was added to the ticket by ${interaction.user}.`);
  }

  if (name === 'remove') {
    const user = interaction.options.getUser('user');
    if (user.id === info.ownerId) return interaction.reply(eph("You can't remove the ticket owner. Use /close instead."));
    await interaction.channel.permissionOverwrites.delete(user.id);
    return interaction.reply(`➖ ${user} was removed from the ticket by ${interaction.user}.`);
  }
}

// ---------------------------------------------------------------
// Interactions
// ---------------------------------------------------------------
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) return await handleCommand(interaction);

    // Dropdown: choose ticket type -> show modal
    if (interaction.isStringSelectMenu() && interaction.customId === 'ticket_select') {
      const key = interaction.values[0];
      const type = TICKET_TYPES[key];
      if (!type) return;

      // Blacklist check
      const banned = data.blacklist[interaction.user.id];
      if (banned) {
        return interaction.reply(eph(`🚫 You are blacklisted from opening tickets.\n**Reason:** ${banned.reason}`));
      }

      // One open ticket per user
      const existing = interaction.guild.channels.cache.find((c) => parseTicket(c)?.ownerId === interaction.user.id);
      if (existing) {
        return interaction.reply(eph(`You already have an open ticket: ${existing}`));
      }

      const modal = new ModalBuilder().setCustomId(`ticket_modal:${key}`).setTitle(type.label);
      modal.addComponents(
        type.fields.map((f) =>
          new ActionRowBuilder().addComponents(
            new TextInputBuilder()
              .setCustomId(f.id)
              .setLabel(f.label)
              .setStyle(f.style)
              .setRequired(true)
              .setMaxLength(f.style === LONG ? 1000 : 100)
          )
        )
      );

      await interaction.showModal(modal);

      // Reset the dropdown so the same option can be picked again later
      interaction.message.edit({ components: interaction.message.components }).catch(() => {});
      return;
    }

    // Modal submit -> create ticket channel
    if (interaction.isModalSubmit() && interaction.customId.startsWith('ticket_modal:')) {
      const key = interaction.customId.split(':')[1];
      const type = TICKET_TYPES[key];
      if (!type) return;

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const guild = interaction.guild;
      const safeName = interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'user';

      const allow = [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
      ];

      const overwrites = [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: interaction.user.id, allow },
        { id: client.user.id, allow: [...allow, PermissionFlagsBits.ManageChannels] },
      ];
      if (STAFF_ROLE_ID) overwrites.push({ id: STAFF_ROLE_ID, allow });

      const channel = await guild.channels.create({
        name: `${type.prefix}-${safeName}`,
        type: ChannelType.GuildText,
        parent: TICKET_CATEGORY_ID || null,
        topic: `ticket-owner:${interaction.user.id}`,
        permissionOverwrites: overwrites,
      });

      const embed = new EmbedBuilder()
        .setTitle(`${type.emoji} ${type.label}`)
        .setColor(type.color)
        .setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() })
        .addFields(
          type.fields.map((f) => ({
            name: f.label,
            value: interaction.fields.getTextInputValue(f.id) || '—',
          }))
        )
        .setTimestamp();

      if (type.notice) embed.setDescription(type.notice);

      const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ticket_claim').setLabel('Claim').setEmoji('🙋').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('ticket_close').setLabel('Close Ticket').setEmoji('🔒').setStyle(ButtonStyle.Danger)
      );

      await channel.send({
        content: `${interaction.user}${STAFF_ROLE_ID ? ` <@&${STAFF_ROLE_ID}>` : ''}`,
        embeds: [embed],
        components: [buttons],
      });

      await sendLog(
        guild,
        new EmbedBuilder()
          .setTitle('🎫 Ticket Opened')
          .setColor(type.color)
          .addFields(
            { name: 'Ticket', value: `${channel}`, inline: true },
            { name: 'Type', value: type.label, inline: true },
            { name: 'Opened by', value: `${interaction.user}`, inline: true }
          )
          .setTimestamp()
      );

      return interaction.editReply({ content: `Your ticket has been created: ${channel}` });
    }

    // Button: claim
    if (interaction.isButton() && interaction.customId === 'ticket_claim') {
      if (!isStaff(interaction.member)) return interaction.reply(eph('Only staff can claim tickets.'));
      if (!parseTicket(interaction.channel)) return;
      return await claimTicket(interaction);
    }

    // Button: close
    if (interaction.isButton() && interaction.customId === 'ticket_close') {
      const info = parseTicket(interaction.channel);
      if (!info) return;
      if (info.ownerId !== interaction.user.id && !isStaff(interaction.member)) {
        return interaction.reply(eph("You can't close this ticket."));
      }
      return await closeTicket(interaction, null);
    }
  } catch (err) {
    console.error(err);
    const msg = eph('Something went wrong, please try again.');
    if (interaction.deferred || interaction.replied) interaction.followUp(msg).catch(() => {});
    else interaction.reply(msg).catch(() => {});
  }
});

client.login(MY_BOT_TOKEN);
