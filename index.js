require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  MessageFlags,
} = require('discord.js');

const { DISCORD_TOKEN, GUILD_ID, STAFF_ROLE_ID, TICKET_CATEGORY_ID } = process.env;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

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
    style: ButtonStyle.Primary,
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
    style: ButtonStyle.Success,
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
    style: ButtonStyle.Secondary,
    fields: [
      { id: 'ign', label: 'What is your IGN?', style: SHORT },
      { id: 'amount', label: 'How many skellys would you like?', style: SHORT },
      { id: 'action', label: 'Are you selling / buying?', style: SHORT },
    ],
    notice: null,
  },
};

// ---------------------------------------------------------------
// Slash command registration
// ---------------------------------------------------------------
client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const guild = await client.guilds.fetch(GUILD_ID);
  await guild.commands.set([
    new SlashCommandBuilder()
      .setName('ticketpanel')
      .setDescription('Post the ticket panel in this channel')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .toJSON(),
  ]);
  console.log('Slash commands registered.');
});

// ---------------------------------------------------------------
// Interactions
// ---------------------------------------------------------------
client.on('interactionCreate', async (interaction) => {
  try {
    // /ticketpanel
    if (interaction.isChatInputCommand() && interaction.commandName === 'ticketpanel') {
      const embed = new EmbedBuilder()
        .setTitle('🎫 Open a Ticket')
        .setDescription(
          'Click a button below to open a ticket.\n\n' +
            Object.values(TICKET_TYPES)
              .map((t) => `${t.emoji} **${t.label}**`)
              .join('\n')
        )
        .setColor(0x5865f2);

      const row = new ActionRowBuilder().addComponents(
        Object.entries(TICKET_TYPES).map(([key, t]) =>
          new ButtonBuilder()
            .setCustomId(`ticket_open:${key}`)
            .setLabel(t.label)
            .setEmoji(t.emoji)
            .setStyle(t.style)
        )
      );

      await interaction.channel.send({ embeds: [embed], components: [row] });
      return interaction.reply({ content: 'Panel posted ✅', flags: MessageFlags.Ephemeral });
    }

    // Button: open ticket -> show modal
    if (interaction.isButton() && interaction.customId.startsWith('ticket_open:')) {
      const key = interaction.customId.split(':')[1];
      const type = TICKET_TYPES[key];
      if (!type) return;

      // One open ticket per user
      const existing = interaction.guild.channels.cache.find(
        (c) => c.topic === `ticket-owner:${interaction.user.id}`
      );
      if (existing) {
        return interaction.reply({
          content: `You already have an open ticket: ${existing}`,
          flags: MessageFlags.Ephemeral,
        });
      }

      const modal = new ModalBuilder()
        .setCustomId(`ticket_modal:${key}`)
        .setTitle(type.label);

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

      return interaction.showModal(modal);
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
        {
          id: client.user.id,
          allow: [...allow, PermissionFlagsBits.ManageChannels],
        },
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
        .setAuthor({
          name: interaction.user.tag,
          iconURL: interaction.user.displayAvatarURL(),
        })
        .addFields(
          type.fields.map((f) => ({
            name: f.label,
            value: interaction.fields.getTextInputValue(f.id) || '—',
          }))
        )
        .setTimestamp();

      if (type.notice) embed.setDescription(type.notice);

      const closeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('ticket_close')
          .setLabel('Close Ticket')
          .setEmoji('🔒')
          .setStyle(ButtonStyle.Danger)
      );

      await channel.send({
        content: `${interaction.user}${STAFF_ROLE_ID ? ` <@&${STAFF_ROLE_ID}>` : ''}`,
        embeds: [embed],
        components: [closeRow],
      });

      return interaction.editReply({ content: `Your ticket has been created: ${channel}` });
    }

    // Button: close ticket
    if (interaction.isButton() && interaction.customId === 'ticket_close') {
      const isOwner = interaction.channel.topic === `ticket-owner:${interaction.user.id}`;
      const isStaff =
        (STAFF_ROLE_ID && interaction.member.roles.cache.has(STAFF_ROLE_ID)) ||
        interaction.member.permissions.has(PermissionFlagsBits.ManageChannels);

      if (!isOwner && !isStaff) {
        return interaction.reply({
          content: "You can't close this ticket.",
          flags: MessageFlags.Ephemeral,
        });
      }

      await interaction.reply('🔒 Closing this ticket in 5 seconds...');
      setTimeout(() => interaction.channel.delete().catch(console.error), 5000);
    }
  } catch (err) {
    console.error(err);
    const msg = { content: 'Something went wrong, please try again.', flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) interaction.followUp(msg).catch(() => {});
    else interaction.reply(msg).catch(() => {});
  }
});

client.login(DISCORD_TOKEN);
