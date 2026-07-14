import { randomBytes } from "node:crypto";

export class PterodactylError extends Error {
  constructor(
    message,
    {
      status = null,
      path = null,
      details = null
    } = {}
  ) {
    super(message);

    this.name = "PterodactylError";
    this.status = status;
    this.path = path;
    this.details = details;
  }
}

function attributes(resource) {
  if (
    !resource ||
    typeof resource !== "object"
  ) {
    return null;
  }

  return resource.attributes ?? resource;
}

function unwrapResource(response) {
  if (
    !response ||
    typeof response !== "object"
  ) {
    return null;
  }

  return attributes(response.data ?? response);
}

function getRelationshipData(
  response,
  relationshipName
) {
  if (
    !response ||
    typeof response !== "object"
  ) {
    return [];
  }

  const resource = response.data ?? response;

  const possibleLocations = [
    resource?.relationships?.[
      relationshipName
    ]?.data,

    resource?.attributes?.relationships?.[
      relationshipName
    ]?.data,

    response?.relationships?.[
      relationshipName
    ]?.data,

    response?.attributes?.relationships?.[
      relationshipName
    ]?.data,

    response?.data?.relationships?.[
      relationshipName
    ]?.data,

    response?.data?.attributes
      ?.relationships?.[relationshipName]
      ?.data
  ];

  for (const location of possibleLocations) {
    if (Array.isArray(location)) {
      return location;
    }
  }

  return [];
}

function normalizeNamePart(
  value,
  fallback
) {
  const cleaned = String(value ?? "")
    .replace(
      /[^\p{L}\p{N}\s'-]/gu,
      ""
    )
    .trim()
    .slice(0, 100);

  return cleaned || fallback;
}

function generatePassword() {
  return (
    `${randomBytes(18).toString(
      "base64url"
    )}Aa1!`
  );
}

function generateUsername(email) {
  const localPart =
    email.split("@")[0] ?? "discord";

  const base =
    localPart
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, "")
      .slice(0, 20) || "discord";

  return (
    `${base}_` +
    randomBytes(4).toString("hex")
  );
}

function toBoolean(value) {
  return (
    value === true ||
    value === 1 ||
    value === "1" ||
    value === "true"
  );
}

function isAllocationAssigned(
  allocation
) {
  return toBoolean(allocation?.assigned);
}

export class PterodactylClient {
  constructor({
    baseUrl,
    apiKey,
    timeoutMs = 20_000
  }) {
    if (!baseUrl) {
      throw new Error(
        "Pterodactyl base URL is required."
      );
    }

    if (!apiKey) {
      throw new Error(
        "Pterodactyl API key is required."
      );
    }

    this.baseUrl = baseUrl.replace(
      /\/+$/,
      ""
    );

    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
  }

  async request(
    method,
    path,
    {
      query = {},
      body
    } = {}
  ) {
    const url = new URL(
      `${this.baseUrl}${path}`
    );

    for (
      const [key, value] of Object.entries(
        query
      )
    ) {
      if (
        value !== undefined &&
        value !== null &&
        value !== ""
      ) {
        url.searchParams.set(
          key,
          String(value)
        );
      }
    }

    const controller =
      new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await fetch(url, {
        method,

        headers: {
          Authorization:
            `Bearer ${this.apiKey}`,

          Accept:
            "Application/vnd.pterodactyl.v1+json",

          "Content-Type":
            "application/json"
        },

        body:
          body === undefined
            ? undefined
            : JSON.stringify(body),

        signal: controller.signal
      });

      const responseText =
        await response.text();

      let parsedResponse = null;

      if (responseText) {
        try {
          parsedResponse =
            JSON.parse(responseText);
        } catch {
          parsedResponse = responseText;
        }
      }

      if (!response.ok) {
        const apiMessages =
          Array.isArray(
            parsedResponse?.errors
          )
            ? parsedResponse.errors
                .map((error) => {
                  return (
                    error?.detail ||
                    error?.code ||
                    error?.title
                  );
                })
                .filter(Boolean)
            : [];

        const fallbackMessage =
          typeof parsedResponse ===
          "string"
            ? parsedResponse.slice(0, 500)
            : (
                "Pterodactyl returned " +
                `HTTP ${response.status}.`
              );

        throw new PterodactylError(
          apiMessages.join(" | ") ||
            fallbackMessage,
          {
            status: response.status,
            path,
            details: parsedResponse
          }
        );
      }

      return parsedResponse;
    } catch (error) {
      if (
        error?.name === "AbortError"
      ) {
        throw new PterodactylError(
          (
            "The Pterodactyl request " +
            `timed out after ` +
            `${this.timeoutMs} ms.`
          ),
          {
            path
          }
        );
      }

      if (
        error instanceof
        PterodactylError
      ) {
        throw error;
      }

      throw new PterodactylError(
        (
          "Unable to connect to " +
          `Pterodactyl: ${error.message}`
        ),
        {
          path
        }
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async paginate(path, query = {}) {
    const results = [];
    let page = 1;

    while (true) {
      const response =
        await this.request(
          "GET",
          path,
          {
            query: {
              ...query,
              page,
              per_page: 100
            }
          }
        );

      const rawPageData =
        Array.isArray(response?.data)
          ? response.data
          : Array.isArray(response)
            ? response
            : [];

      const pageData = rawPageData
        .map((resource) =>
          attributes(resource)
        )
        .filter(Boolean);

      results.push(...pageData);

      const pagination =
        response?.meta?.pagination ??
        response?.pagination ??
        null;

      const totalPages = Number(
        pagination?.total_pages ?? 1
      );

      if (
        page >= totalPages ||
        rawPageData.length === 0
      ) {
        break;
      }

      page += 1;

      if (page > 1_000) {
        throw new PterodactylError(
          (
            "Pagination limit exceeded " +
            `for endpoint ${path}.`
          ),
          {
            path
          }
        );
      }
    }

    return results;
  }

  async listNodes() {
    const nodes = await this.paginate(
      "/api/application/nodes"
    );

    return nodes
      .filter(
        (node) =>
          node?.id !== undefined
      )
      .map((node) => ({
        id: Number(node.id),

        uuid: node.uuid ?? null,

        name:
          node.name ??
          `Node ${node.id}`,

        locationId: Number(
          node.location_id ?? 0
        ),

        maintenanceMode: toBoolean(
          node.maintenance_mode
        )
      }))
      .sort((first, second) =>
        first.name.localeCompare(
          second.name
        )
      );
  }

  async listEggs() {
    const nests = await this.paginate(
      "/api/application/nests"
    );

    const eggs = [];

    for (const nest of nests) {
      if (!nest?.id) {
        continue;
      }

      const nestEggs =
        await this.paginate(
          (
            "/api/application/nests/" +
            `${nest.id}/eggs`
          )
        );

      for (const egg of nestEggs) {
        if (!egg?.id) {
          continue;
        }

        eggs.push({
          id: Number(egg.id),

          nestId: Number(nest.id),

          name:
            egg.name ??
            `Egg ${egg.id}`,

          nestName:
            nest.name ??
            `Nest ${nest.id}`,

          description:
            egg.description ?? ""
        });
      }
    }

    return eggs.sort(
      (first, second) => {
        const nestComparison =
          first.nestName.localeCompare(
            second.nestName
          );

        if (nestComparison !== 0) {
          return nestComparison;
        }

        return first.name.localeCompare(
          second.name
        );
      }
    );
  }

  async getEgg(nestId, eggId) {
    const normalizedNestId =
      Number(nestId);

    const normalizedEggId =
      Number(eggId);

    if (
      !Number.isInteger(
        normalizedNestId
      ) ||
      normalizedNestId <= 0
    ) {
      throw new PterodactylError(
        `Nest ID "${nestId}" is invalid.`
      );
    }

    if (
      !Number.isInteger(
        normalizedEggId
      ) ||
      normalizedEggId <= 0
    ) {
      throw new PterodactylError(
        `Egg ID "${eggId}" is invalid.`
      );
    }

    const path =
      "/api/application/nests/" +
      `${normalizedNestId}/eggs/` +
      `${normalizedEggId}`;

    const response =
      await this.request(
        "GET",
        path,
        {
          query: {
            include: "variables"
          }
        }
      );

    const egg =
      unwrapResource(response);

    if (!egg?.id) {
      throw new PterodactylError(
        (
          `Egg ID ${normalizedEggId} ` +
          `inside Nest ID ` +
          `${normalizedNestId} was not ` +
          "found or the API response " +
          "format is invalid."
        ),
        {
          path,
          details: response
        }
      );
    }

    const relationshipVariables =
      getRelationshipData(
        response,
        "variables"
      );

    let variables =
      relationshipVariables
        .map((variable) =>
          attributes(variable)
        )
        .filter(Boolean);

    if (
      variables.length === 0 &&
      Array.isArray(egg.variables)
    ) {
      variables = egg.variables
        .map((variable) =>
          attributes(variable)
        )
        .filter(Boolean);
    }

    return {
      ...egg,

      id: Number(egg.id),

      nest: Number(
        egg.nest ??
          egg.nest_id ??
          normalizedNestId
      ),

      variables
    };
  }

  async listAllocations(nodeId) {
    const normalizedNodeId =
      Number(nodeId);

    if (
      !Number.isInteger(
        normalizedNodeId
      ) ||
      normalizedNodeId <= 0
    ) {
      throw new PterodactylError(
        `Node ID "${nodeId}" is invalid.`
      );
    }

    const allocations =
      await this.paginate(
        (
          "/api/application/nodes/" +
          `${normalizedNodeId}/allocations`
        )
      );

    return allocations
      .filter(
        (allocation) =>
          allocation?.id !== undefined
      )
      .map((allocation) => ({
        ...allocation,

        id: Number(allocation.id),

        nodeId: normalizedNodeId,

        ip:
          allocation.ip ??
          "0.0.0.0",

        ipAlias:
          allocation.ip_alias ??
          allocation.alias ??
          null,

        port: Number(
          allocation.port ?? 0
        ),

        assigned:
          isAllocationAssigned(
            allocation
          )
      }))
      .sort((first, second) => {
        const portComparison =
          first.port - second.port;

        if (portComparison !== 0) {
          return portComparison;
        }

        return String(
          first.ip
        ).localeCompare(
          String(second.ip)
        );
      });
  }

  async listFreeAllocations(nodeId) {
    const allocations =
      await this.listAllocations(nodeId);

    return allocations.filter(
      (allocation) =>
        allocation.assigned === false
    );
  }

  async getFreeAllocation(nodeId) {
    const allocations =
      await this.listFreeAllocations(
        nodeId
      );

    const allocation =
      allocations[0] ?? null;

    if (!allocation) {
      throw new PterodactylError(
        (
          "The selected node has no " +
          "available allocations."
        )
      );
    }

    return allocation;
  }

  async findUserByEmail(email) {
    const normalizedEmail =
      String(email)
        .trim()
        .toLowerCase();

    const users =
      await this.paginate(
        "/api/application/users",
        {
          "filter[email]":
            normalizedEmail
        }
      );

    return (
      users.find((user) => {
        return (
          String(user.email)
            .trim()
            .toLowerCase() ===
          normalizedEmail
        );
      }) ?? null
    );
  }

  async getOrCreateUser(
    email,
    discordUser,
    autoCreate = true
  ) {
    const normalizedEmail =
      String(email)
        .trim()
        .toLowerCase();

    const existingUser =
      await this.findUserByEmail(
        normalizedEmail
      );

    if (existingUser) {
      return {
        user: existingUser,
        created: false,
        password: null
      };
    }

    if (!autoCreate) {
      throw new PterodactylError(
        (
          "No panel account exists for " +
          `${normalizedEmail}, and ` +
          "AUTO_CREATE_PANEL_USERS is " +
          "disabled."
        )
      );
    }

    const displayName =
      discordUser?.globalName ||
      discordUser?.displayName ||
      discordUser?.username ||
      "Discord User";

    const nameParts =
      String(displayName)
        .split(/\s+/)
        .map((part) => part.trim())
        .filter(Boolean);

    const firstName =
      normalizeNamePart(
        nameParts[0],
        "Discord"
      );

    const lastName =
      normalizeNamePart(
        nameParts
          .slice(1)
          .join(" "),
        "User"
      );

    const password =
      generatePassword();

    try {
      const response =
        await this.request(
          "POST",
          "/api/application/users",
          {
            body: {
              email: normalizedEmail,

              username:
                generateUsername(
                  normalizedEmail
                ),

              first_name: firstName,

              last_name: lastName,

              password,

              language: "en",

              root_admin: false
            }
          }
        );

      const createdUser =
        unwrapResource(response);

      if (!createdUser?.id) {
        throw new PterodactylError(
          (
            "The user request was sent, " +
            "but the panel did not return " +
            "valid user data."
          ),
          {
            path:
              "/api/application/users",

            details: response
          }
        );
      }

      return {
        user: createdUser,
        created: true,
        password
      };
    } catch (error) {
      if (
        error instanceof
          PterodactylError &&
        error.status === 422
      ) {
        const user =
          await this.findUserByEmail(
            normalizedEmail
          );

        if (user) {
          return {
            user,
            created: false,
            password: null
          };
        }
      }

      throw error;
    }
  }

  async createServer(payload) {
    if (
      !payload ||
      typeof payload !== "object"
    ) {
      throw new PterodactylError(
        "The server creation payload is invalid."
      );
    }

    const response =
      await this.request(
        "POST",
        "/api/application/servers",
        {
          body: payload
        }
      );

    const server =
      unwrapResource(response);

    if (!server?.id) {
      throw new PterodactylError(
        (
          "The panel did not return valid " +
          "server data after creation."
        ),
        {
          path:
            "/api/application/servers",

          details: response
        }
      );
    }

    return server;
  }

  async findServersByExactName(name) {
    const normalizedName =
      String(name)
        .trim()
        .toLowerCase();

    if (!normalizedName) {
      return [];
    }

    const servers =
      await this.paginate(
        "/api/application/servers",
        {
          "filter[name]":
            String(name).trim()
        }
      );

    return servers.filter(
      (server) => {
        return (
          String(server.name)
            .trim()
            .toLowerCase() ===
          normalizedName
        );
      }
    );
  }

  async getServer(serverId) {
    const normalizedServerId =
      Number(serverId);

    if (
      !Number.isInteger(
        normalizedServerId
      ) ||
      normalizedServerId <= 0
    ) {
      throw new PterodactylError(
        (
          `Server ID "${serverId}" ` +
          "is invalid."
        )
      );
    }

    const path =
      "/api/application/servers/" +
      normalizedServerId;

    const response =
      await this.request(
        "GET",
        path
      );

    const server =
      unwrapResource(response);

    if (!server?.id) {
      throw new PterodactylError(
        (
          `Server ID ` +
          `${normalizedServerId} was ` +
          "not found or the API response " +
          "format is invalid."
        ),
        {
          path,
          details: response
        }
      );
    }

    return server;
  }

  async deleteServer(serverId) {
    const normalizedServerId =
      Number(serverId);

    if (
      !Number.isInteger(
        normalizedServerId
      ) ||
      normalizedServerId <= 0
    ) {
      throw new PterodactylError(
        (
          `Server ID "${serverId}" ` +
          "is invalid."
        )
      );
    }

    await this.request(
      "DELETE",
      (
        "/api/application/servers/" +
        normalizedServerId
      )
    );

    return true;
  }
}