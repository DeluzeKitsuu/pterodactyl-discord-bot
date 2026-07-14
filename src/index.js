import { randomBytes } from "node:crypto";

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle
} from "discord.js";

import { config } from "./config.js";

import {
  PterodactylClient,
  PterodactylError
} from "./pterodactyl.js";

const PAGE_SIZE = 25;
const SETUP_TTL_MS = 5 * 60 * 1_000;
const CONFIRMATION_TTL_MS = 5 * 60 * 1_000;
const MAX_PTERODACTYL_INTEGER = 2_147_483_647;

const COLORS = Object.freeze({
  primary: 0x3498db,
  success: 0x2ecc71,
  warning: 0xf39c12,
  danger: 0xe74c3c,
  neutral: 0x5865f2
});

class UserFacingError extends Error {
  constructor(message) {
    super(message);
    this.name = "UserFacingError";
  }
}

const pterodactyl = new PterodactylClient({
  baseUrl: config.pterodactylUrl,
  apiKey: config.pterodactylApiKey,
  timeoutMs: config.requestTimeoutMs
});

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

const createSessions = new Map();
const pendingCreates = new Map();
const pendingDeletes = new Map();

function createToken() {
  return randomBytes(10).toString("hex");
}

function truncate(value, maximum) {
  const text = String(value ?? "");

  if (text.length <= maximum) {
    return text;
  }

  return `${text.slice(0, maximum - 1)}…`;
}

function pageCount(items) {
  return Math.max(
    1,
    Math.ceil(items.length / PAGE_SIZE)
  );
}

function pageSlice(items, page) {
  const start = page * PAGE_SIZE;

  return items.slice(
    start,
    start + PAGE_SIZE
  );
}

function clampPage(page, items) {
  return Math.max(
    0,
    Math.min(
      page,
      pageCount(items) - 1
    )
  );
}

function pageForItem(items, selectedId) {
  const index = items.findIndex(
    (item) => item.id === selectedId
  );

  if (index < 0) {
    return 0;
  }

  return Math.floor(index / PAGE_SIZE);
}

function hasRequiredRole(interaction) {
  const roles = interaction.member?.roles;

  if (!roles) {
    return false;
  }

  if (Array.isArray(roles)) {
    return roles.includes(config.roleId);
  }

  if (roles.cache?.has) {
    return roles.cache.has(config.roleId);
  }

  return false;
}

async function respond(interaction, payload) {
  const normalized =
    typeof payload === "string"
      ? { content: payload }
      : payload;

  if (interaction.deferred) {
    return interaction.editReply(normalized);
  }

  if (interaction.replied) {
    return interaction.followUp({
      ...normalized,
      ephemeral: true
    });
  }

  return interaction.reply({
    ...normalized,
    ephemeral: true
  });
}

async function ensureAuthorized(interaction) {
  if (
    !interaction.inGuild() ||
    interaction.guildId !== config.guildId
  ) {
    await respond(
      interaction,
      "❌ This command can only be used in the configured Discord server."
    );

    return false;
  }

  if (!hasRequiredRole(interaction)) {
    await respond(
      interaction,
      "❌ You do not have the required role to use this administrator bot."
    );

    return false;
  }

  return true;
}

function publicError(error) {
  if (
    error instanceof UserFacingError ||
    error instanceof PterodactylError
  ) {
    return truncate(error.message, 1_500);
  }

  return "An unexpected internal error occurred.";
}

function touchSetupSession(session) {
  session.expiresAt =
    Date.now() + SETUP_TTL_MS;
}

function getSelectedNode(session) {
  return (
    session.nodes.find(
      (node) => node.id === session.nodeId
    ) ?? null
  );
}

function getSelectedEgg(session) {
  return (
    session.eggs.find(
      (egg) => egg.id === session.eggId
    ) ?? null
  );
}

function getSelectedAllocation(session) {
  return (
    session.allocations.find(
      (allocation) =>
        allocation.id === session.allocationId
    ) ?? null
  );
}

function getAdditionalAllocations(session) {
  const selectedIds = new Set(
    session.additionalAllocationIds
  );

  return session.allocations.filter(
    (allocation) =>
      selectedIds.has(allocation.id)
  );
}

function getPrimaryCandidates(session) {
  const additionalIds = new Set(
    session.additionalAllocationIds
  );

  return session.allocations.filter(
    (allocation) =>
      !additionalIds.has(allocation.id)
  );
}

function getAdditionalCandidates(session) {
  const selectedIds = new Set(
    session.additionalAllocationIds
  );

  return session.allocations.filter(
    (allocation) =>
      allocation.id !== session.allocationId &&
      !selectedIds.has(allocation.id)
  );
}

function formatAllocation(allocation) {
  const host =
    allocation.ipAlias ||
    allocation.ip ||
    "Unknown IP";

  return `${host}:${allocation.port}`;
}

function formatAllocationList(allocations) {
  if (allocations.length === 0) {
    return "None";
  }

  return truncate(
    allocations
      .map(
        (allocation) =>
          `• ${formatAllocation(allocation)}`
      )
      .join("\n"),
    1_024
  );
}

function buildDisabledSelect(
  customId,
  placeholder,
  label
) {
  return new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .setDisabled(true)
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel(label)
        .setValue("unavailable")
    );
}

function buildNodeSelect(session, disabled) {
  session.nodePage = clampPage(
    session.nodePage,
    session.nodes
  );

  const currentNodes = pageSlice(
    session.nodes,
    session.nodePage
  );

  if (currentNodes.length === 0) {
    return buildDisabledSelect(
      `setup:node:${session.id}`,
      "No nodes are available",
      "No nodes available"
    );
  }

  return new StringSelectMenuBuilder()
    .setCustomId(`setup:node:${session.id}`)
    .setPlaceholder(
      "Select a Pterodactyl node"
    )
    .setMinValues(1)
    .setMaxValues(1)
    .setDisabled(disabled)
    .addOptions(
      ...currentNodes.map((node) => {
        const description = [
          `Node ID ${node.id}`,
          node.maintenanceMode
            ? "Maintenance mode"
            : null
        ]
          .filter(Boolean)
          .join(" • ");

        return new StringSelectMenuOptionBuilder()
          .setLabel(
            truncate(node.name, 100)
          )
          .setValue(String(node.id))
          .setDescription(
            truncate(description, 100)
          )
          .setDefault(
            node.id === session.nodeId
          );
      })
    );
}

function buildEggSelect(session, disabled) {
  session.eggPage = clampPage(
    session.eggPage,
    session.eggs
  );

  const currentEggs = pageSlice(
    session.eggs,
    session.eggPage
  );

  if (currentEggs.length === 0) {
    return buildDisabledSelect(
      `setup:egg:${session.id}`,
      "No eggs are available",
      "No eggs available"
    );
  }

  return new StringSelectMenuBuilder()
    .setCustomId(`setup:egg:${session.id}`)
    .setPlaceholder(
      "Select a Pterodactyl egg"
    )
    .setMinValues(1)
    .setMaxValues(1)
    .setDisabled(disabled)
    .addOptions(
      ...currentEggs.map((egg) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(
            truncate(egg.name, 100)
          )
          .setValue(String(egg.id))
          .setDescription(
            truncate(
              `${egg.nestName} • Egg ID ${egg.id}`,
              100
            )
          )
          .setDefault(
            egg.id === session.eggId
          )
      )
    );
}

function buildAllocationSelect(
  session,
  disabled
) {
  const candidates =
    getPrimaryCandidates(session);

  session.allocationPage = clampPage(
    session.allocationPage,
    candidates
  );

  const currentAllocations = pageSlice(
    candidates,
    session.allocationPage
  );

  if (!session.nodeId) {
    return buildDisabledSelect(
      `setup:allocation:${session.id}`,
      "Select a node first",
      "Select a node first"
    );
  }

  if (currentAllocations.length === 0) {
    return buildDisabledSelect(
      `setup:allocation:${session.id}`,
      "No free ports are available",
      "No free ports available"
    );
  }

  return new StringSelectMenuBuilder()
    .setCustomId(
      `setup:allocation:${session.id}`
    )
    .setPlaceholder(
      "Select the primary port"
    )
    .setMinValues(1)
    .setMaxValues(1)
    .setDisabled(disabled)
    .addOptions(
      ...currentAllocations.map(
        (allocation) => {
          const host =
            allocation.ipAlias ||
            allocation.ip ||
            "Unknown IP";

          return new StringSelectMenuOptionBuilder()
            .setLabel(
              truncate(
                `Port ${allocation.port}`,
                100
              )
            )
            .setValue(
              String(allocation.id)
            )
            .setDescription(
              truncate(
                `${host} • Allocation ID ${allocation.id}`,
                100
              )
            )
            .setDefault(
              allocation.id ===
                session.allocationId
            );
        }
      )
    );
}

function buildNavigationSelect(
  session,
  disabled
) {
  const options = [];

  const nodePages =
    pageCount(session.nodes);

  const eggPages =
    pageCount(session.eggs);

  const allocationPages = pageCount(
    getPrimaryCandidates(session)
  );

  if (session.nodePage > 0) {
    options.push({
      label: "Previous node page",
      value: "node-prev",
      description:
        `Node page ${session.nodePage}`
    });
  }

  if (
    session.nodePage <
    nodePages - 1
  ) {
    options.push({
      label: "Next node page",
      value: "node-next",
      description:
        `Node page ${session.nodePage + 2}`
    });
  }

  if (session.allocationPage > 0) {
    options.push({
      label: "Previous port page",
      value: "allocation-prev",
      description:
        `Port page ${session.allocationPage}`
    });
  }

  if (
    session.allocationPage <
    allocationPages - 1
  ) {
    options.push({
      label: "Next port page",
      value: "allocation-next",
      description:
        `Port page ${session.allocationPage + 2}`
    });
  }

  if (session.eggPage > 0) {
    options.push({
      label: "Previous egg page",
      value: "egg-prev",
      description:
        `Egg page ${session.eggPage}`
    });
  }

  if (
    session.eggPage <
    eggPages - 1
  ) {
    options.push({
      label: "Next egg page",
      value: "egg-next",
      description:
        `Egg page ${session.eggPage + 2}`
    });
  }

  if (options.length === 0) {
    return buildDisabledSelect(
      `setup:navigate:${session.id}`,
      "No additional pages",
      "No additional pages"
    );
  }

  return new StringSelectMenuBuilder()
    .setCustomId(
      `setup:navigate:${session.id}`
    )
    .setPlaceholder("Page navigation")
    .setMinValues(1)
    .setMaxValues(1)
    .setDisabled(disabled)
    .addOptions(
      ...options.map((option) =>
        new StringSelectMenuOptionBuilder()
          .setLabel(option.label)
          .setValue(option.value)
          .setDescription(
            truncate(
              option.description,
              100
            )
          )
      )
    );
}

function buildSetupPayload(
  session,
  notice = null
) {
  const disabled =
    session.locked ||
    session.expired;

  const selectedNode =
    getSelectedNode(session);

  const selectedEgg =
    getSelectedEgg(session);

  const selectedAllocation =
    getSelectedAllocation(session);

  const additionalAllocations =
    getAdditionalAllocations(session);

  const remainingAdditional =
    getAdditionalCandidates(session);

  const statusText =
    session.expired
      ? "Expired"
      : session.locked
        ? "Locked"
        : "Active";

  const descriptionLines = [
    "Select a node, primary port, and egg before opening the form.",
    "**Refresh All** reloads nodes, eggs, and ports from the panel.",
    "**Refresh Ports** only reloads ports for the selected node."
  ];

  if (notice) {
    descriptionLines.push(
      "",
      `⚠️ ${notice}`
    );
  }

  const embed = new EmbedBuilder()
    .setColor(
      session.expired
        ? COLORS.danger
        : session.locked
          ? COLORS.warning
          : COLORS.primary
    )
    .setTitle(
      "Create Pterodactyl Server"
    )
    .setDescription(
      descriptionLines.join("\n")
    )
    .addFields(
      {
        name: "Selected Node",
        value: selectedNode
          ? `${selectedNode.name} \`#${selectedNode.id}\``
          : "Not selected",
        inline: true
      },
      {
        name: "Primary Port",
        value: selectedAllocation
          ? formatAllocation(
              selectedAllocation
            )
          : "Not selected",
        inline: true
      },
      {
        name: "Selected Egg",
        value: selectedEgg
          ? `${selectedEgg.nestName} / ${selectedEgg.name}`
          : "Not selected",
        inline: true
      },
      {
        name:
          `Additional Ports (${additionalAllocations.length})`,
        value: formatAllocationList(
          additionalAllocations
        ),
        inline: false
      },
      {
        name: "Pages",
        value: [
          `Node: ${session.nodePage + 1}/${pageCount(session.nodes)}`,
          `Port: ${session.allocationPage + 1}/${pageCount(getPrimaryCandidates(session))}`,
          `Egg: ${session.eggPage + 1}/${pageCount(session.eggs)}`
        ].join(" • "),
        inline: false
      },
      {
        name: "Setup Status",
        value: statusText,
        inline: true
      }
    )
    .setFooter({
      text:
        "This setup expires after 5 minutes of inactivity."
    });

  const nodeRow =
    new ActionRowBuilder().addComponents(
      buildNodeSelect(
        session,
        disabled
      )
    );

  const allocationRow =
    new ActionRowBuilder().addComponents(
      buildAllocationSelect(
        session,
        disabled
      )
    );

  const eggRow =
    new ActionRowBuilder().addComponents(
      buildEggSelect(
        session,
        disabled
      )
    );

  const navigationRow =
    new ActionRowBuilder().addComponents(
      buildNavigationSelect(
        session,
        disabled
      )
    );

  const controlRow =
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(
          `setup:refresh-all:${session.id}`
        )
        .setLabel("Refresh All")
        .setEmoji("🔄")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),

      new ButtonBuilder()
        .setCustomId(
          `setup:refresh-ports:${session.id}`
        )
        .setLabel("Refresh Ports")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(
          disabled ||
          !session.nodeId
        ),

      new ButtonBuilder()
        .setCustomId(
          `setup:add-port:${session.id}`
        )
        .setLabel("Add Additional Port")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(
          disabled ||
          !session.allocationId ||
          remainingAdditional.length === 0
        ),

      new ButtonBuilder()
        .setCustomId(
          `setup:open:${session.id}`
        )
        .setLabel("Open Form")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(
          disabled ||
          !selectedNode ||
          !selectedEgg ||
          !selectedAllocation
        ),

      new ButtonBuilder()
        .setCustomId(
          `setup:cancel:${session.id}`
        )
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled)
    );

  return {
    embeds: [embed],
    components: [
      nodeRow,
      allocationRow,
      eggRow,
      navigationRow,
      controlRow
    ]
  };
}

async function editSetupMessage(
  session,
  payload
) {
  await session.webhook.editMessage(
    "@original",
    payload
  );
}

function removePendingCreatesForSession(
  sessionId
) {
  for (
    const [token, pending]
    of pendingCreates
  ) {
    if (
      pending.sessionId === sessionId
    ) {
      pendingCreates.delete(token);
    }
  }
}

async function expireSetupSession(session) {
  if (!session || session.expired) {
    return;
  }

  session.expired = true;
  session.locked = true;

  removePendingCreatesForSession(
    session.id
  );

  try {
    await editSetupMessage(
      session,
      buildSetupPayload(
        session,
        "This setup request expired after 5 minutes of inactivity."
      )
    );
  } catch (error) {
    console.error(
      "Failed to disable an expired setup message:",
      error
    );
  }

  createSessions.delete(session.id);
}

async function getValidSetupSession(
  interaction,
  sessionId,
  {
    allowLocked = false
  } = {}
) {
  const session =
    createSessions.get(sessionId);

  if (!session) {
    throw new UserFacingError(
      "This server setup was not found or has expired. Run `/server create` again."
    );
  }

  if (
    session.expiresAt <= Date.now()
  ) {
    await expireSetupSession(session);

    throw new UserFacingError(
      "This server setup expired after 5 minutes of inactivity."
    );
  }

  if (
    session.userId !==
    interaction.user.id
  ) {
    throw new UserFacingError(
      "Only the user who opened this setup can use it."
    );
  }

  if (
    session.locked &&
    !allowLocked
  ) {
    throw new UserFacingError(
      "This setup is currently locked because its form has already been submitted. Complete or cancel the confirmation."
    );
  }

  touchSetupSession(session);

  return session;
}

async function refreshAllocations(
  session,
  {
    resetSelections = false
  } = {}
) {
  if (!session.nodeId) {
    session.allocations = [];
    session.allocationId = null;
    session.additionalAllocationIds = [];
    session.allocationPage = 0;
    session.additionalPage = 0;
    return;
  }

  const allocations =
    await pterodactyl.listFreeAllocations(
      session.nodeId
    );

  session.allocations = allocations;

  if (resetSelections) {
    session.allocationId = null;
    session.additionalAllocationIds = [];
  } else {
    const availableIds = new Set(
      allocations.map(
        (allocation) => allocation.id
      )
    );

    if (
      !availableIds.has(
        session.allocationId
      )
    ) {
      session.allocationId = null;
    }

    session.additionalAllocationIds =
      session.additionalAllocationIds.filter(
        (allocationId) =>
          availableIds.has(allocationId) &&
          allocationId !==
            session.allocationId
      );
  }

  session.allocationPage = clampPage(
    session.allocationPage,
    getPrimaryCandidates(session)
  );

  session.additionalPage = clampPage(
    session.additionalPage,
    getAdditionalCandidates(session)
  );
}

async function refreshAllResources(session) {
  const previousNodeId =
    session.nodeId;

  const [nodes, eggs] =
    await Promise.all([
      pterodactyl.listNodes(),
      pterodactyl.listEggs()
    ]);

  if (nodes.length === 0) {
    throw new UserFacingError(
      "No nodes are available in the panel."
    );
  }

  if (eggs.length === 0) {
    throw new UserFacingError(
      "No eggs are available in the panel."
    );
  }

  session.nodes = nodes;
  session.eggs = eggs;

  const nodeStillExists = nodes.some(
    (node) =>
      node.id === session.nodeId
  );

  if (!nodeStillExists) {
    session.nodeId = nodes[0].id;
  }

  const eggStillExists = eggs.some(
    (egg) =>
      egg.id === session.eggId
  );

  if (!eggStillExists) {
    session.eggId = eggs[0].id;
  }

  session.nodePage = pageForItem(
    nodes,
    session.nodeId
  );

  session.eggPage = pageForItem(
    eggs,
    session.eggId
  );

  await refreshAllocations(session, {
    resetSelections:
      previousNodeId !==
      session.nodeId
  });
}

function getDockerImage(egg) {
  if (egg.docker_image) {
    return egg.docker_image;
  }

  if (
    Array.isArray(egg.docker_images)
  ) {
    return egg.docker_images[0] ?? null;
  }

  if (
    egg.docker_images &&
    typeof egg.docker_images === "object"
  ) {
    return (
      Object.values(
        egg.docker_images
      )[0] ?? null
    );
  }

  return null;
}

function parseNonNegativeInteger(
  value,
  label
) {
  const normalized = value.trim();

  if (!/^\d+$/.test(normalized)) {
    throw new UserFacingError(
      `${label} must be an integer greater than or equal to 0.`
    );
  }

  const number = Number(normalized);

  if (
    !Number.isSafeInteger(number) ||
    number < 0
  ) {
    throw new UserFacingError(
      `${label} is not valid.`
    );
  }

  return number;
}

function checkedMultiply(
  value,
  multiplier,
  label
) {
  const result = value * multiplier;

  if (
    !Number.isSafeInteger(result) ||
    result > MAX_PTERODACTYL_INTEGER
  ) {
    throw new UserFacingError(
      `${label} is too large for Pterodactyl.`
    );
  }

  return result;
}

function validateEmail(email) {
  const normalized =
    email.trim().toLowerCase();

  if (
    normalized.length > 191 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
      normalized
    )
  ) {
    throw new UserFacingError(
      "The email address is invalid."
    );
  }

  return normalized;
}

function buildServerModal(session) {
  const modal = new ModalBuilder()
    .setCustomId(
      `setupmodal:${session.id}`
    )
    .setTitle(
      "Create Pterodactyl Server"
    );

  const serverName =
    new TextInputBuilder()
      .setCustomId("server_name")
      .setLabel("Server Name")
      .setPlaceholder(
        "Example: Survival Server"
      )
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMinLength(1)
      .setMaxLength(191);

  const cpu =
    new TextInputBuilder()
      .setCustomId("cpu")
      .setLabel(
        "CPU Cores (0 = Unlimited)"
      )
      .setPlaceholder(
        "1 = 100%, 2 = 200%"
      )
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue("0")
      .setMaxLength(10);

  const ram =
    new TextInputBuilder()
      .setCustomId("ram")
      .setLabel(
        "RAM GB (0 = Unlimited)"
      )
      .setPlaceholder(
        "1 = 1024 MB, 30 = 30720 MB"
      )
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue("0")
      .setMaxLength(10);

  const disk =
    new TextInputBuilder()
      .setCustomId("disk")
      .setLabel(
        "Storage GB (0 = Unlimited)"
      )
      .setPlaceholder(
        "1 = 1000 MB, 30 = 30000 MB"
      )
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue("0")
      .setMaxLength(10);

  const email =
    new TextInputBuilder()
      .setCustomId("email")
      .setLabel("Owner Email")
      .setPlaceholder(
        "owner@example.com"
      )
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue(
        config.defaultOwnerEmail
      )
      .setMaxLength(191);

  modal.addComponents(
    new ActionRowBuilder()
      .addComponents(serverName),

    new ActionRowBuilder()
      .addComponents(cpu),

    new ActionRowBuilder()
      .addComponents(ram),

    new ActionRowBuilder()
      .addComponents(disk),

    new ActionRowBuilder()
      .addComponents(email)
  );

  return modal;
}

function buildAdditionalPicker(
  session,
  notice = null
) {
  const candidates =
    getAdditionalCandidates(session);

  session.additionalPage = clampPage(
    session.additionalPage,
    candidates
  );

  const currentCandidates = pageSlice(
    candidates,
    session.additionalPage
  );

  let select;

  if (
    currentCandidates.length === 0
  ) {
    select = buildDisabledSelect(
      `allocpicker:select:${session.id}`,
      "No additional ports are available",
      "No additional ports available"
    );
  } else {
    select =
      new StringSelectMenuBuilder()
        .setCustomId(
          `allocpicker:select:${session.id}`
        )
        .setPlaceholder(
          "Select one or more additional ports"
        )
        .setMinValues(1)
        .setMaxValues(
          currentCandidates.length
        )
        .addOptions(
          ...currentCandidates.map(
            (allocation) => {
              const host =
                allocation.ipAlias ||
                allocation.ip ||
                "Unknown IP";

              return new StringSelectMenuOptionBuilder()
                .setLabel(
                  truncate(
                    `Port ${allocation.port}`,
                    100
                  )
                )
                .setValue(
                  String(allocation.id)
                )
                .setDescription(
                  truncate(
                    `${host} • Allocation ID ${allocation.id}`,
                    100
                  )
                );
            }
          )
        );
  }

  const selectedAllocations =
    getAdditionalAllocations(session);

  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle(
      "Additional Port Selection"
    )
    .setDescription(
      [
        "Ports already selected as the primary port or an additional port are removed from this list.",
        notice
          ? `\n⚠️ ${notice}`
          : ""
      ]
        .filter(Boolean)
        .join("\n")
    )
    .addFields(
      {
        name:
          `Selected Additional Ports (${selectedAllocations.length})`,
        value: formatAllocationList(
          selectedAllocations
        ),
        inline: false
      },
      {
        name: "Available Ports",
        value: String(candidates.length),
        inline: true
      },
      {
        name: "Page",
        value:
          `${session.additionalPage + 1}/${pageCount(candidates)}`,
        inline: true
      }
    )
    .setFooter({
      text:
        "You can continue selecting ports until no free ports remain."
    });

  const selectRow =
    new ActionRowBuilder()
      .addComponents(select);

  const buttonRow =
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(
            `allocpicker:prev:${session.id}`
          )
          .setLabel("Previous")
          .setStyle(
            ButtonStyle.Secondary
          )
          .setDisabled(
            session.additionalPage === 0
          ),

        new ButtonBuilder()
          .setCustomId(
            `allocpicker:next:${session.id}`
          )
          .setLabel("Next")
          .setStyle(
            ButtonStyle.Secondary
          )
          .setDisabled(
            session.additionalPage >=
              pageCount(candidates) - 1
          ),

        new ButtonBuilder()
          .setCustomId(
            `allocpicker:refresh:${session.id}`
          )
          .setLabel("Refresh")
          .setEmoji("🔄")
          .setStyle(
            ButtonStyle.Secondary
          ),

        new ButtonBuilder()
          .setCustomId(
            `allocpicker:clear:${session.id}`
          )
          .setLabel("Clear")
          .setStyle(ButtonStyle.Danger)
          .setDisabled(
            selectedAllocations.length === 0
          ),

        new ButtonBuilder()
          .setCustomId(
            `allocpicker:done:${session.id}`
          )
          .setLabel("Done")
          .setStyle(ButtonStyle.Success)
      );

  return {
    embeds: [embed],
    components: [
      selectRow,
      buttonRow
    ]
  };
}

/**
 * Sends credentials only to the Discord user who requested
 * the server creation.
 */
async function sendPanelAccountCredentialsDm(
  discordUser,
  {
    email,
    password
  }
) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.success)
    .setTitle(
      "Your New Pterodactyl Account"
    )
    .setDescription(
      "A new Pterodactyl panel account was created for your server request."
    )
    .addFields(
      {
        name: "Panel URL",
        value: config.pterodactylUrl,
        inline: false
      },
      {
        name: "Email",
        value: `\`${email}\``,
        inline: false
      },
      {
        name: "Temporary Password",
        value: `||${password}||`,
        inline: false
      },
      {
        name: "Important Security Notice",
        value:
          "Please change your password immediately after your first login.",
        inline: false
      }
    )
    .setFooter({
      text:
        "Keep these credentials private. Do not share this message with anyone."
    })
    .setTimestamp();

  const panelButton =
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel(
          "Open Pterodactyl Panel"
        )
        .setStyle(ButtonStyle.Link)
        .setURL(
          config.pterodactylUrl
        )
    );

  await discordUser.send({
    content:
      "Your Pterodactyl panel account is ready.",
    embeds: [embed],
    components: [panelButton]
  });
}

function buildPanelAccountStatus(
  panelAccount
) {
  if (!panelAccount) {
    return null;
  }

  if (panelAccount.dmSent) {
    return {
      name: "New Panel Account",
      value: [
        `Email: \`${panelAccount.email}\``,
        "",
        "The temporary password was sent to your Discord DMs.",
        "Please change the password immediately after your first login."
      ].join("\n"),
      inline: false
    };
  }

  return {
    name: "New Panel Account — DM Delivery Failed",
    value: [
      "The bot could not send you a direct message.",
      "Your credentials are shown here because this response is private.",
      "",
      `Email: \`${panelAccount.email}\``,
      `Temporary password: ||${panelAccount.password}||`,
      "",
      "**Please change your password immediately after your first login.**",
      "Enable direct messages if you want the bot to retry sending the credentials."
    ].join("\n"),
    inline: false
  };
}

function buildCreateButtons(
  token,
  disabled = false
) {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(
          `createconfirm:confirm:${token}`
        )
        .setLabel("Create")
        .setStyle(ButtonStyle.Success)
        .setDisabled(disabled),

      new ButtonBuilder()
        .setCustomId(
          `createconfirm:cancel:${token}`
        )
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled)
    );
}

function buildCreateReview(
  pending,
  error = null
) {
  const cpuText =
    pending.cpuCores === 0
      ? "0 — Unlimited"
      : `${pending.cpuCores} Core = ${pending.cpuPercent}%`;

  const ramText =
    pending.ramGb === 0
      ? "0 — Unlimited"
      : `${pending.ramGb} GB = ${pending.memoryMb} MB`;

  const diskText =
    pending.diskGb === 0
      ? "0 — Unlimited"
      : `${pending.diskGb} GB = ${pending.diskMb} MB`;

  const embed = new EmbedBuilder()
    .setColor(
      error
        ? COLORS.danger
        : COLORS.warning
    )
    .setTitle(
      "Confirm Server Creation"
    )
    .setDescription(
      error
        ? [
            "The server could not be created:",
            `\`\`\`text\n${truncate(error, 1_300)}\n\`\`\``,
            "Fix the panel issue or press Create to retry. Press Cancel to unlock the setup."
          ].join("\n")
        : "Review the configuration before creating the server."
    )
    .addFields(
      {
        name: "Server Name",
        value: pending.serverName,
        inline: false
      },
      {
        name: "Node",
        value:
          `${pending.node.name} \`#${pending.node.id}\``,
        inline: true
      },
      {
        name: "Egg",
        value:
          `${pending.egg.nestName} / ${pending.egg.name}`,
        inline: true
      },
      {
        name: "Primary Port",
        value: formatAllocation(
          pending.primaryAllocation
        ),
        inline: true
      },
      {
        name:
          `Additional Ports (${pending.additionalAllocations.length})`,
        value: formatAllocationList(
          pending.additionalAllocations
        ),
        inline: false
      },
      {
        name: "CPU",
        value: cpuText,
        inline: true
      },
      {
        name: "RAM",
        value: ramText,
        inline: true
      },
      {
        name: "Storage",
        value: diskText,
        inline: true
      },
      {
        name: "Owner Email",
        value: pending.email,
        inline: false
      }
    )
    .setFooter({
      text:
        "This confirmation expires after 5 minutes."
    });

  const accountStatus =
    buildPanelAccountStatus(
      pending.newPanelAccount
    );

  if (accountStatus) {
    embed.addFields(accountStatus);
  }

  return {
    embeds: [embed],
    components: [
      buildCreateButtons(
        pending.token
      )
    ]
  };
}

function buildDeleteButtons(
  token,
  disabled = false
) {
  return new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(
          `deleteconfirm:confirm:${token}`
        )
        .setLabel("Confirm Delete")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(disabled),

      new ButtonBuilder()
        .setCustomId(
          `deleteconfirm:cancel:${token}`
        )
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled)
    );
}

function buildDeleteWarning(
  pending,
  error = null
) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.danger)
    .setTitle(
      "Safely Delete Server"
    )
    .setDescription(
      error
        ? [
            "The deletion request failed:",
            `\`\`\`text\n${truncate(error, 1_300)}\n\`\`\``,
            "The server was not marked as deleted. You may retry after fixing the problem."
          ].join("\n")
        : [
            "Deleting this server is irreversible.",
            "",
            "All server data, files, managed databases, backups, and user access assignments may be permanently removed.",
            "",
            "The bot will send a standard non-force deletion request to Pterodactyl."
          ].join("\n")
    )
    .addFields(
      {
        name: "Server",
        value: pending.serverName,
        inline: false
      },
      {
        name: "Server ID",
        value: String(pending.serverId),
        inline: true
      },
      {
        name: "Identifier",
        value:
          pending.identifier ||
          "Unknown",
        inline: true
      }
    )
    .setFooter({
      text:
        "This confirmation expires after 5 minutes."
    });

  return {
    embeds: [embed],
    components: [
      buildDeleteButtons(
        pending.token
      )
    ]
  };
}

async function handleCreateCommand(
  interaction
) {
  await interaction.deferReply({
    ephemeral: true
  });

  const [nodes, eggs] =
    await Promise.all([
      pterodactyl.listNodes(),
      pterodactyl.listEggs()
    ]);

  if (nodes.length === 0) {
    throw new UserFacingError(
      "No nodes are available in the panel."
    );
  }

  if (eggs.length === 0) {
    throw new UserFacingError(
      "No eggs are available in the panel."
    );
  }

  const id = createToken();

  const session = {
    id,
    userId: interaction.user.id,
    guildId: interaction.guildId,
    webhook: interaction.webhook,

    nodes,
    eggs,

    nodeId: nodes[0].id,
    eggId: eggs[0].id,

    allocations: [],
    allocationId: null,
    additionalAllocationIds: [],

    nodePage: 0,
    eggPage: 0,
    allocationPage: 0,
    additionalPage: 0,

    locked: false,
    expired: false,
    pendingCreateToken: null,

    expiresAt:
      Date.now() + SETUP_TTL_MS
  };

  await refreshAllocations(session, {
    resetSelections: true
  });

  createSessions.set(id, session);

  await interaction.editReply(
    buildSetupPayload(session)
  );
}

async function handleDeleteCommand(
  interaction
) {
  await interaction.deferReply({
    ephemeral: true
  });

  const name =
    interaction.options
      .getString("name", true)
      .trim();

  const matches =
    await pterodactyl
      .findServersByExactName(name);

  if (matches.length === 0) {
    throw new UserFacingError(
      `No server named "${name}" was found.`
    );
  }

  if (matches.length > 1) {
    const identifiers = matches
      .slice(0, 10)
      .map(
        (server) =>
          `• ID ${server.id} — ${server.identifier}`
      )
      .join("\n");

    throw new UserFacingError(
      `More than one server is named "${name}". Use a unique server name.\n${identifiers}`
    );
  }

  const server = matches[0];
  const token = createToken();

  const pending = {
    token,
    userId: interaction.user.id,
    serverId: Number(server.id),
    serverName: server.name,
    identifier: server.identifier,
    processing: false,
    expiresAt:
      Date.now() +
      CONFIRMATION_TTL_MS
  };

  pendingDeletes.set(
    token,
    pending
  );

  await interaction.editReply(
    buildDeleteWarning(pending)
  );
}

async function handleSetupComponent(
  interaction
) {
  const [, action, sessionId] =
    interaction.customId.split(":");

  const session =
    await getValidSetupSession(
      interaction,
      sessionId
    );

  switch (action) {
    case "node": {
      const nodeId = Number(
        interaction.values[0]
      );

      if (
        !session.nodes.some(
          (node) => node.id === nodeId
        )
      ) {
        throw new UserFacingError(
          "The selected node is no longer available."
        );
      }

      await interaction.deferUpdate();

      session.nodeId = nodeId;

      session.nodePage = pageForItem(
        session.nodes,
        nodeId
      );

      await refreshAllocations(
        session,
        {
          resetSelections: true
        }
      );

      await interaction.editReply(
        buildSetupPayload(
          session,
          "The node was changed. Primary and additional ports were reset."
        )
      );

      return;
    }

    case "allocation": {
      const allocationId = Number(
        interaction.values[0]
      );

      const allocation =
        session.allocations.find(
          (item) =>
            item.id === allocationId
        );

      if (!allocation) {
        throw new UserFacingError(
          "The selected port is no longer available. Refresh the port list."
        );
      }

      if (
        session.additionalAllocationIds
          .includes(allocationId)
      ) {
        throw new UserFacingError(
          "This port is already selected as an additional port."
        );
      }

      session.allocationId =
        allocationId;

      session.allocationPage =
        pageForItem(
          getPrimaryCandidates(session),
          allocationId
        );

      await interaction.update(
        buildSetupPayload(session)
      );

      return;
    }

    case "egg": {
      const eggId = Number(
        interaction.values[0]
      );

      if (
        !session.eggs.some(
          (egg) => egg.id === eggId
        )
      ) {
        throw new UserFacingError(
          "The selected egg is no longer available."
        );
      }

      session.eggId = eggId;

      session.eggPage =
        pageForItem(
          session.eggs,
          eggId
        );

      await interaction.update(
        buildSetupPayload(session)
      );

      return;
    }

    case "navigate": {
      const direction =
        interaction.values[0];

      switch (direction) {
        case "node-prev":
          session.nodePage = Math.max(
            0,
            session.nodePage - 1
          );
          break;

        case "node-next":
          session.nodePage = Math.min(
            pageCount(session.nodes) - 1,
            session.nodePage + 1
          );
          break;

        case "allocation-prev":
          session.allocationPage =
            Math.max(
              0,
              session.allocationPage - 1
            );
          break;

        case "allocation-next":
          session.allocationPage =
            Math.min(
              pageCount(
                getPrimaryCandidates(
                  session
                )
              ) - 1,
              session.allocationPage + 1
            );
          break;

        case "egg-prev":
          session.eggPage = Math.max(
            0,
            session.eggPage - 1
          );
          break;

        case "egg-next":
          session.eggPage = Math.min(
            pageCount(session.eggs) - 1,
            session.eggPage + 1
          );
          break;

        default:
          throw new UserFacingError(
            "The selected page action is invalid."
          );
      }

      await interaction.update(
        buildSetupPayload(session)
      );

      return;
    }

    case "refresh-all": {
      await interaction.deferUpdate();

      await refreshAllResources(session);

      await interaction.editReply(
        buildSetupPayload(
          session,
          "Nodes, eggs, and ports were refreshed."
        )
      );

      return;
    }

    case "refresh-ports": {
      await interaction.deferUpdate();

      await refreshAllocations(session);

      await interaction.editReply(
        buildSetupPayload(
          session,
          "The port list was refreshed."
        )
      );

      return;
    }

    case "add-port": {
      if (!session.allocationId) {
        throw new UserFacingError(
          "Select a primary port before adding additional ports."
        );
      }

      await interaction.reply({
        ...buildAdditionalPicker(
          session
        ),
        ephemeral: true
      });

      return;
    }

    case "open": {
      if (
        !getSelectedNode(session) ||
        !getSelectedEgg(session) ||
        !getSelectedAllocation(session)
      ) {
        throw new UserFacingError(
          "Select a node, primary port, and egg first."
        );
      }

      /*
       * The setup is not locked here.
       * Closing the modal with X does not send a Discord event.
       * It is locked only after the modal is submitted.
       */
      await interaction.showModal(
        buildServerModal(session)
      );

      return;
    }

    case "cancel": {
      removePendingCreatesForSession(
        session.id
      );

      createSessions.delete(
        session.id
      );

      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setColor(COLORS.neutral)
            .setTitle(
              "Server Creation Cancelled"
            )
            .setDescription(
              "The server setup was cancelled."
            )
        ],
        components: []
      });

      return;
    }

    default:
      throw new UserFacingError(
        "Unknown setup action."
      );
  }
}

async function handleAdditionalPicker(
  interaction
) {
  const [, action, sessionId] =
    interaction.customId.split(":");

  const session =
    await getValidSetupSession(
      interaction,
      sessionId
    );

  switch (action) {
    case "select": {
      const candidates = new Set(
        getAdditionalCandidates(session)
          .map(
            (allocation) =>
              allocation.id
          )
      );

      for (
        const selectedValue
        of interaction.values
      ) {
        const allocationId =
          Number(selectedValue);

        if (
          candidates.has(allocationId) &&
          allocationId !==
            session.allocationId &&
          !session
            .additionalAllocationIds
            .includes(allocationId)
        ) {
          session
            .additionalAllocationIds
            .push(allocationId);
        }
      }

      session.additionalPage =
        clampPage(
          session.additionalPage,
          getAdditionalCandidates(
            session
          )
        );

      await interaction.update(
        buildAdditionalPicker(
          session,
          "The selected ports were added."
        )
      );

      await editSetupMessage(
        session,
        buildSetupPayload(session)
      );

      return;
    }

    case "prev": {
      session.additionalPage =
        Math.max(
          0,
          session.additionalPage - 1
        );

      await interaction.update(
        buildAdditionalPicker(session)
      );

      return;
    }

    case "next": {
      session.additionalPage =
        Math.min(
          pageCount(
            getAdditionalCandidates(
              session
            )
          ) - 1,
          session.additionalPage + 1
        );

      await interaction.update(
        buildAdditionalPicker(session)
      );

      return;
    }

    case "refresh": {
      await interaction.deferUpdate();

      await refreshAllocations(session);

      await interaction.editReply(
        buildAdditionalPicker(
          session,
          "Available ports were refreshed."
        )
      );

      await editSetupMessage(
        session,
        buildSetupPayload(
          session,
          "The port list was refreshed."
        )
      );

      return;
    }

    case "clear": {
      session.additionalAllocationIds =
        [];

      session.additionalPage = 0;

      await interaction.update(
        buildAdditionalPicker(
          session,
          "All additional ports were removed."
        )
      );

      await editSetupMessage(
        session,
        buildSetupPayload(session)
      );

      return;
    }

    case "done": {
      await interaction.update({
        embeds: [
          new EmbedBuilder()
            .setColor(COLORS.success)
            .setTitle(
              "Additional Port Selection Completed"
            )
            .setDescription(
              "The selected additional ports were saved in the server setup."
            )
        ],
        components: []
      });

      return;
    }

    default:
      throw new UserFacingError(
        "Unknown additional port action."
      );
  }
}

async function handleSetupModal(
  interaction
) {
  const sessionId =
    interaction.customId.split(":")[1];

  const session =
    await getValidSetupSession(
      interaction,
      sessionId
    );

  const serverName =
    interaction.fields
      .getTextInputValue(
        "server_name"
      )
      .trim();

  if (
    !serverName ||
    serverName.length > 191 ||
    /[\r\n\t]/.test(serverName)
  ) {
    throw new UserFacingError(
      "The server name is invalid."
    );
  }

  const cpuCores =
    parseNonNegativeInteger(
      interaction.fields
        .getTextInputValue("cpu"),
      "CPU"
    );

  const ramGb =
    parseNonNegativeInteger(
      interaction.fields
        .getTextInputValue("ram"),
      "RAM"
    );

  const diskGb =
    parseNonNegativeInteger(
      interaction.fields
        .getTextInputValue("disk"),
      "Storage"
    );

  const email = validateEmail(
    interaction.fields
      .getTextInputValue("email")
  );

  const cpuPercent =
    checkedMultiply(
      cpuCores,
      100,
      "CPU"
    );

  const memoryMb =
    checkedMultiply(
      ramGb,
      1_024,
      "RAM"
    );

  const diskMb =
    checkedMultiply(
      diskGb,
      1_000,
      "Storage"
    );

  const node =
    getSelectedNode(session);

  const egg =
    getSelectedEgg(session);

  const primaryAllocation =
    getSelectedAllocation(session);

  const additionalAllocations =
    getAdditionalAllocations(session);

  if (
    !node ||
    !egg ||
    !primaryAllocation
  ) {
    throw new UserFacingError(
      "The selected node, port, or egg is no longer available. Refresh the setup."
    );
  }

  const token = createToken();

  const pending = {
    token,
    sessionId: session.id,
    userId: interaction.user.id,
    guildId: interaction.guildId,

    serverName,
    email,

    node,
    egg,

    primaryAllocation,
    additionalAllocations,

    cpuCores,
    cpuPercent,

    ramGb,
    memoryMb,

    diskGb,
    diskMb,

    /*
     * Filled only when the bot creates a new panel account.
     *
     * {
     *   email,
     *   password,
     *   dmSent
     * }
     */
    newPanelAccount: null,

    processing: false,

    expiresAt:
      Date.now() +
      CONFIRMATION_TTL_MS
  };

  pendingCreates.set(
    token,
    pending
  );

  session.locked = true;
  session.pendingCreateToken = token;

  session.expiresAt =
    Date.now() +
    CONFIRMATION_TTL_MS;

  try {
    await editSetupMessage(
      session,
      buildSetupPayload(
        session,
        "The form was submitted. Complete or cancel the confirmation message."
      )
    );

    await interaction.reply({
      ...buildCreateReview(pending),
      ephemeral: true
    });
  } catch (error) {
    session.locked = false;
    session.pendingCreateToken = null;

    pendingCreates.delete(token);

    try {
      await editSetupMessage(
        session,
        buildSetupPayload(session)
      );
    } catch (editError) {
      console.error(
        "Failed to unlock the setup after a modal error:",
        editError
      );
    }

    throw error;
  }
}

async function handleCreateConfirmation(
  interaction
) {
  const [, action, token] =
    interaction.customId.split(":");

  const pending =
    pendingCreates.get(token);

  if (!pending) {
    throw new UserFacingError(
      "This server creation confirmation was not found or has expired."
    );
  }

  if (
    pending.expiresAt <= Date.now()
  ) {
    pendingCreates.delete(token);

    const session =
      createSessions.get(
        pending.sessionId
      );

    if (session) {
      await expireSetupSession(session);
    }

    throw new UserFacingError(
      "This server creation confirmation has expired."
    );
  }

  if (
    pending.userId !==
    interaction.user.id
  ) {
    throw new UserFacingError(
      "Only the user who created this request can confirm it."
    );
  }

  const session =
    createSessions.get(
      pending.sessionId
    );

  if (action === "cancel") {
    pendingCreates.delete(token);

    if (
      session &&
      !session.expired
    ) {
      session.locked = false;
      session.pendingCreateToken = null;

      touchSetupSession(session);

      try {
        await editSetupMessage(
          session,
          buildSetupPayload(
            session,
            "The confirmation was cancelled. The setup is active again."
          )
        );
      } catch (error) {
        console.error(
          "Failed to unlock the original setup:",
          error
        );
      }
    }

    await interaction.update({
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.neutral)
          .setTitle(
            "Server Creation Cancelled"
          )
          .setDescription(
            `Server **${pending.serverName}** was not created. The original setup is active again.`
          )
      ],
      components: []
    });

    return;
  }

  if (action !== "confirm") {
    throw new UserFacingError(
      "Unknown creation confirmation action."
    );
  }

  if (pending.processing) {
    throw new UserFacingError(
      "This server creation request is already being processed."
    );
  }

  if (!session) {
    pendingCreates.delete(token);

    throw new UserFacingError(
      "The original setup has expired. Run `/server create` again."
    );
  }

  pending.processing = true;

  pending.expiresAt =
    Date.now() +
    CONFIRMATION_TTL_MS;

  session.expiresAt =
    Date.now() +
    CONFIRMATION_TTL_MS;

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.primary)
        .setTitle("Creating Server")
        .setDescription(
          "Validating ports, egg, owner account, and server configuration..."
        )
    ],
    components: [
      buildCreateButtons(
        token,
        true
      )
    ]
  });

  try {
    const freshAllocations =
      await pterodactyl
        .listFreeAllocations(
          pending.node.id
        );

    const freshAllocationMap =
      new Map(
        freshAllocations.map(
          (allocation) => [
            allocation.id,
            allocation
          ]
        )
      );

    const requiredAllocationIds = [
      pending.primaryAllocation.id,
      ...pending.additionalAllocations.map(
        (allocation) =>
          allocation.id
      )
    ];

    const uniqueAllocationIds =
      new Set(requiredAllocationIds);

    if (
      uniqueAllocationIds.size !==
      requiredAllocationIds.length
    ) {
      throw new UserFacingError(
        "Duplicate allocation IDs were detected in the request."
      );
    }

    const missingAllocationIds =
      requiredAllocationIds.filter(
        (allocationId) =>
          !freshAllocationMap.has(
            allocationId
          )
      );

    if (
      missingAllocationIds.length > 0
    ) {
      throw new UserFacingError(
        `One or more selected ports are no longer available: ${missingAllocationIds.join(", ")}. Cancel this confirmation, refresh the port list, and select new ports.`
      );
    }

    const primaryAllocation =
      freshAllocationMap.get(
        pending.primaryAllocation.id
      );

    const additionalAllocations =
      pending.additionalAllocations
        .map((allocation) =>
          freshAllocationMap.get(
            allocation.id
          )
        )
        .filter(Boolean);

    const egg =
      await pterodactyl.getEgg(
        pending.egg.nestId,
        pending.egg.id
      );

    const dockerImage =
      getDockerImage(egg);

    if (!dockerImage) {
      throw new UserFacingError(
        "The selected egg does not have a Docker image."
      );
    }

    if (!egg.startup) {
      throw new UserFacingError(
        "The selected egg does not have a startup command."
      );
    }

    const owner =
      await pterodactyl
        .getOrCreateUser(
          pending.email,
          interaction.user,
          config.autoCreatePanelUsers
        );

    /*
     * Save credentials in the pending request before attempting
     * the DM. This allows an ephemeral fallback when DMs are closed.
     */
    if (
      owner.created &&
      !pending.newPanelAccount
    ) {
      pending.newPanelAccount = {
        email: pending.email,
        password: owner.password,
        dmSent: false
      };
    }

    /*
     * Retry the DM whenever the Create button is pressed again
     * and the previous DM attempt failed.
     */
    if (
      pending.newPanelAccount &&
      !pending.newPanelAccount.dmSent
    ) {
      try {
        await sendPanelAccountCredentialsDm(
          interaction.user,
          {
            email:
              pending.newPanelAccount.email,

            password:
              pending.newPanelAccount.password
          }
        );

        pending.newPanelAccount.dmSent =
          true;
      } catch (dmError) {
        /*
         * Never log the generated password.
         */
        console.warn(
          `Unable to send panel credentials to Discord user ${interaction.user.id}:`,
          dmError?.message ??
            "Unknown DM error"
        );
      }
    }

    const environment = {};

    for (
      const variable
      of egg.variables ?? []
    ) {
      if (!variable?.env_variable) {
        continue;
      }

      environment[
        variable.env_variable
      ] = String(
        variable.default_value ?? ""
      );
    }

    const server =
      await pterodactyl.createServer({
        name: pending.serverName,

        description:
          `Created through Discord by ${interaction.user.username} (${interaction.user.id})`,

        user: Number(owner.user.id),
        egg: Number(egg.id),

        docker_image: dockerImage,
        startup: egg.startup,

        environment,

        limits: {
          memory: pending.memoryMb,
          swap: config.serverSwapMb,
          disk: pending.diskMb,
          io: config.serverIoWeight,
          cpu: pending.cpuPercent
        },

        feature_limits: {
          databases:
            config.featureLimits.databases,

          allocations:
            config.featureLimits.allocations,

          backups:
            config.featureLimits.backups
        },

        allocation: {
          default: Number(
            primaryAllocation.id
          ),

          additional:
            additionalAllocations.map(
              (allocation) =>
                Number(allocation.id)
            )
        },

        start_on_completion: true,
        oom_disabled: false,
        skip_scripts: false
      });

    pendingCreates.delete(token);

    session.locked = true;
    session.pendingCreateToken = null;

    try {
      await editSetupMessage(
        session,
        buildSetupPayload(
          session,
          `Server **${server.name}** was created successfully. This setup is now closed.`
        )
      );
    } catch (error) {
      console.error(
        "Failed to update the completed setup message:",
        error
      );
    }

    createSessions.delete(session.id);

    const panelLink =
      server.identifier
        ? `${config.pterodactylUrl}/server/${encodeURIComponent(server.identifier)}`
        : config.pterodactylUrl;

    const successEmbed =
      new EmbedBuilder()
        .setColor(COLORS.success)
        .setTitle(
          "Server Created Successfully"
        )
        .setDescription(
          `[Open server in the Pterodactyl Panel](${panelLink})`
        )
        .addFields(
          {
            name: "Server Name",
            value: server.name,
            inline: false
          },
          {
            name: "Server ID",
            value: String(server.id),
            inline: true
          },
          {
            name: "Identifier",
            value:
              server.identifier ||
              "Unknown",
            inline: true
          },
          {
            name: "Owner Email",
            value: pending.email,
            inline: false
          },
          {
            name: "Primary Port",
            value: formatAllocation(
              primaryAllocation
            ),
            inline: true
          },
          {
            name:
              `Additional Ports (${additionalAllocations.length})`,
            value: formatAllocationList(
              additionalAllocations
            ),
            inline: false
          },
          {
            name: "Node",
            value: pending.node.name,
            inline: true
          }
        );

    const accountStatus =
      buildPanelAccountStatus(
        pending.newPanelAccount
      );

    if (accountStatus) {
      successEmbed.addFields(
        accountStatus
      );
    }

    await interaction.editReply({
      embeds: [successEmbed],
      components: []
    });
  } catch (error) {
    pending.processing = false;

    pending.expiresAt =
      Date.now() +
      CONFIRMATION_TTL_MS;

    session.expiresAt =
      Date.now() +
      CONFIRMATION_TTL_MS;

    await interaction.editReply(
      buildCreateReview(
        pending,
        publicError(error)
      )
    );
  }
}

async function handleDeleteConfirmation(
  interaction
) {
  const [, action, token] =
    interaction.customId.split(":");

  const pending =
    pendingDeletes.get(token);

  if (
    !pending ||
    pending.expiresAt <= Date.now()
  ) {
    pendingDeletes.delete(token);

    throw new UserFacingError(
      "This server deletion confirmation has expired."
    );
  }

  if (
    pending.userId !==
    interaction.user.id
  ) {
    throw new UserFacingError(
      "Only the user who created this request can confirm it."
    );
  }

  if (action === "cancel") {
    pendingDeletes.delete(token);

    await interaction.update({
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.neutral)
          .setTitle(
            "Deletion Cancelled"
          )
          .setDescription(
            `Server **${pending.serverName}** was not deleted.`
          )
      ],
      components: []
    });

    return;
  }

  if (action !== "confirm") {
    throw new UserFacingError(
      "Unknown deletion confirmation action."
    );
  }

  if (pending.processing) {
    throw new UserFacingError(
      "This deletion request is already being processed."
    );
  }

  pending.processing = true;

  await interaction.update({
    embeds: [
      new EmbedBuilder()
        .setColor(COLORS.danger)
        .setTitle("Deleting Server")
        .setDescription(
          "Sending a standard non-force deletion request to Pterodactyl..."
        )
    ],
    components: [
      buildDeleteButtons(
        token,
        true
      )
    ]
  });

  try {
    const server =
      await pterodactyl.getServer(
        pending.serverId
      );

    if (!server) {
      throw new UserFacingError(
        "The server is no longer available."
      );
    }

    await pterodactyl.deleteServer(
      pending.serverId
    );

    pendingDeletes.delete(token);

    await interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.success)
          .setTitle("Server Deleted")
          .setDescription(
            `Pterodactyl successfully deleted **${pending.serverName}**.`
          )
          .addFields(
            {
              name: "Server ID",
              value: String(
                pending.serverId
              ),
              inline: true
            },
            {
              name: "Identifier",
              value:
                pending.identifier ||
                "Unknown",
              inline: true
            }
          )
      ],
      components: []
    });
  } catch (error) {
    pending.processing = false;

    pending.expiresAt =
      Date.now() +
      CONFIRMATION_TTL_MS;

    await interaction.editReply(
      buildDeleteWarning(
        pending,
        publicError(error)
      )
    );
  }
}

const serverCommand =
  new SlashCommandBuilder()
    .setName("server")
    .setDescription(
      "Create or safely delete a Pterodactyl server."
    )
    .addSubcommand(
      (subcommand) =>
        subcommand
          .setName("create")
          .setDescription(
            "Create a new Pterodactyl server."
          )
    )
    .addSubcommand(
      (subcommand) =>
        subcommand
          .setName("delete")
          .setDescription(
            "Safely delete a Pterodactyl server."
          )
          .addStringOption(
            (option) =>
              option
                .setName("name")
                .setDescription(
                  "The exact name of the server to delete."
                )
                .setRequired(true)
                .setMaxLength(191)
          )
    );

client.once(
  Events.ClientReady,
  async (readyClient) => {
    console.log(
      `Logged in as ${readyClient.user.tag}.`
    );

    try {
      const rest =
        new REST({
          version: "10"
        }).setToken(
          config.discordToken
        );

      await rest.put(
        Routes.applicationGuildCommands(
          readyClient.user.id,
          config.guildId
        ),
        {
          body: [
            serverCommand.toJSON()
          ]
        }
      );

      console.log(
        `Guild commands registered for guild ${config.guildId}.`
      );
    } catch (error) {
      console.error(
        "Failed to register Discord commands:",
        error
      );
    }
  }
);

client.on(
  Events.InteractionCreate,
  async (interaction) => {
    try {
      if (
        interaction.isChatInputCommand() &&
        interaction.commandName ===
          "server"
      ) {
        if (
          !await ensureAuthorized(
            interaction
          )
        ) {
          return;
        }

        const subcommand =
          interaction.options
            .getSubcommand(true);

        if (subcommand === "create") {
          await handleCreateCommand(
            interaction
          );
          return;
        }

        if (subcommand === "delete") {
          await handleDeleteCommand(
            interaction
          );
          return;
        }
      }

      if (
        interaction.isModalSubmit() &&
        interaction.customId.startsWith(
          "setupmodal:"
        )
      ) {
        if (
          !await ensureAuthorized(
            interaction
          )
        ) {
          return;
        }

        await handleSetupModal(
          interaction
        );
        return;
      }

      if (
        (
          interaction.isButton() ||
          interaction.isStringSelectMenu()
        ) &&
        interaction.customId.startsWith(
          "setup:"
        )
      ) {
        if (
          !await ensureAuthorized(
            interaction
          )
        ) {
          return;
        }

        await handleSetupComponent(
          interaction
        );
        return;
      }

      if (
        (
          interaction.isButton() ||
          interaction.isStringSelectMenu()
        ) &&
        interaction.customId.startsWith(
          "allocpicker:"
        )
      ) {
        if (
          !await ensureAuthorized(
            interaction
          )
        ) {
          return;
        }

        await handleAdditionalPicker(
          interaction
        );
        return;
      }

      if (
        interaction.isButton() &&
        interaction.customId.startsWith(
          "createconfirm:"
        )
      ) {
        if (
          !await ensureAuthorized(
            interaction
          )
        ) {
          return;
        }

        await handleCreateConfirmation(
          interaction
        );
        return;
      }

      if (
        interaction.isButton() &&
        interaction.customId.startsWith(
          "deleteconfirm:"
        )
      ) {
        if (
          !await ensureAuthorized(
            interaction
          )
        ) {
          return;
        }

        await handleDeleteConfirmation(
          interaction
        );
      }
    } catch (error) {
      console.error(error);

      try {
        await respond(
          interaction,
          `❌ ${publicError(error)}`
        );
      } catch (responseError) {
        console.error(
          "Failed to send the Discord error response:",
          responseError
        );
      }
    }
  }
);

let cleanupRunning = false;

async function cleanupExpiredState() {
  if (cleanupRunning) {
    return;
  }

  cleanupRunning = true;

  try {
    const now = Date.now();

    for (
      const session
      of createSessions.values()
    ) {
      if (
        session.expiresAt <= now
      ) {
        await expireSetupSession(
          session
        );
      }
    }

    for (
      const [token, pending]
      of pendingCreates
    ) {
      if (
        pending.expiresAt <= now &&
        !pending.processing
      ) {
        pendingCreates.delete(token);
      }
    }

    for (
      const [token, pending]
      of pendingDeletes
    ) {
      if (
        pending.expiresAt <= now &&
        !pending.processing
      ) {
        pendingDeletes.delete(token);
      }
    }
  } finally {
    cleanupRunning = false;
  }
}

setInterval(() => {
  void cleanupExpiredState();
}, 30_000).unref();

async function shutdown(signal) {
  console.log(
    `Received ${signal}. Shutting down...`
  );

  client.destroy();
  process.exit(0);
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

await client.login(
  config.discordToken
);