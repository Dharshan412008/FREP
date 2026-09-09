const API_ROOT = "/api";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlainObject(value) {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fallbackMessage(status, statusText) {
  const suffix = status ? ` (${status}${statusText ? ` ${statusText}` : ""})` : "";
  return `Request failed${suffix}`;
}

function normalizeError(payload, status, statusText) {
  const error = isRecord(payload?.error) ? payload.error : null;
  const stringError = typeof payload?.error === "string" ? payload.error.trim() : "";
  const detailMessage = typeof payload?.detail === "string" ? payload.detail.trim() : "";
  const rawMessage = typeof payload === "string" ? payload.trim() : "";
  const message =
    (typeof error?.message === "string" && error.message.trim()) ||
    stringError ||
    (typeof payload?.message === "string" && payload.message.trim()) ||
    detailMessage ||
    rawMessage ||
    fallbackMessage(status, statusText);

  return {
    message,
    code:
      (typeof error?.code === "string" && error.code) ||
      (typeof payload?.code === "string" && payload.code) ||
      "request_failed",
    details: error?.details ?? payload?.details ?? null,
  };
}

/** A failed API request with the backend's structured error metadata preserved. */
export class ApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ApiError";
    this.status = options.status ?? 0;
    this.code = options.code ?? "request_failed";
    this.details = options.details ?? null;
    this.data = options.data ?? null;
    this.method = options.method ?? "GET";
    this.url = options.url ?? "";
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

function prepareBody(body, headers) {
  if (body == null) return body;

  if (Array.isArray(body) || isPlainObject(body)) {
    if (!headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    return JSON.stringify(body);
  }

  // Keep compatibility with callers that already serialized their JSON.
  if (typeof body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return body;
}

async function readJson(response) {
  if (response.status === 204 || response.status === 205) {
    return { payload: null, invalidJson: false };
  }

  const text = await response.text();
  if (!text.trim()) return { payload: null, invalidJson: false };

  try {
    return { payload: JSON.parse(text), invalidJson: false };
  } catch {
    return { payload: text, invalidJson: true };
  }
}

/**
 * Fetch a same-origin JSON endpoint.
 *
 * Plain object and array bodies are serialized automatically. Abort errors are
 * intentionally left untouched so React effects and typeahead requests can
 * distinguish cancellation from a real failure.
 */
export async function apiFetch(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const headers = new Headers(options.headers || {});
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  const body = prepareBody(options.body, headers);
  const { headers: _ignoredHeaders, body: _ignoredBody, ...fetchOptions } = options;

  let response;
  try {
    response = await fetch(path, {
      ...fetchOptions,
      method,
      headers,
      body,
      credentials: "same-origin",
    });
  } catch (cause) {
    if (cause?.name === "AbortError") throw cause;
    throw new ApiError(cause?.message || "Unable to reach the FREP service.", {
      status: 0,
      code: "network_error",
      method,
      url: String(path),
      cause,
    });
  }

  const { payload, invalidJson } = await readJson(response);
  if (!response.ok) {
    const normalized = normalizeError(payload, response.status, response.statusText);
    throw new ApiError(normalized.message, {
      status: response.status,
      code: normalized.code,
      details: normalized.details,
      data: payload,
      method,
      url: response.url || String(path),
    });
  }

  if (invalidJson) {
    throw new ApiError("The FREP service returned an invalid JSON response.", {
      status: response.status,
      code: "invalid_json_response",
      data: payload,
      method,
      url: response.url || String(path),
    });
  }

  return payload;
}

function withQuery(path, query) {
  if (!query) return path;
  const params = new URLSearchParams();
  const entries = query instanceof URLSearchParams ? query.entries() : Object.entries(query);

  for (const [key, rawValue] of entries) {
    if (rawValue === undefined || rawValue === null || rawValue === "") continue;
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      if (value !== undefined && value !== null && value !== "") {
        params.append(key, String(value));
      }
    }
  }

  const search = params.toString();
  return search ? `${path}${path.includes("?") ? "&" : "?"}${search}` : path;
}

function endpointId(value, label) {
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new TypeError(`${label} is required.`);
  }
  return encodeURIComponent(String(value));
}

function get(path, options) {
  return apiFetch(path, { ...(options || {}), method: "GET" });
}

function send(path, method, payload, options) {
  return apiFetch(path, {
    ...(options || {}),
    method,
    body: payload,
  });
}

export function getSession(options) {
  return get(`${API_ROOT}/auth/session`, options);
}

export function login(usernameOrCredentials, passwordOrOptions, maybeOptions) {
  const objectForm = isRecord(usernameOrCredentials);
  const credentials = objectForm
    ? usernameOrCredentials
    : { username: usernameOrCredentials, password: passwordOrOptions };
  const options = objectForm ? passwordOrOptions : maybeOptions;
  return send(`${API_ROOT}/auth/login`, "POST", credentials, options);
}

export function logout(options) {
  return send(`${API_ROOT}/auth/logout`, "POST", {}, options);
}

export function getDashboard(options) {
  return get(`${API_ROOT}/dashboard`, options);
}

export function getResources(filters = {}, options) {
  return get(withQuery(`${API_ROOT}/resources`, filters), options);
}

export function getClusters(options) {
  return get(`${API_ROOT}/clusters`, options);
}

export function getBookings(options) {
  return get(`${API_ROOT}/bookings`, options);
}

export function getAnalytics(options) {
  return get(`${API_ROOT}/analytics`, options);
}

export function getNotifications(options) {
  return get(`${API_ROOT}/notifications`, options);
}

export function getAiStatus(options) {
  return get(`${API_ROOT}/ai/status`, options);
}

export function matchResources(payload, options) {
  return send(`${API_ROOT}/match`, "POST", payload, options);
}

export function getTypeahead(textOrPayload, contextOrOptions = {}, maybeOptions) {
  const objectForm = isRecord(textOrPayload);
  const payload = objectForm
    ? {
        text: textOrPayload.text,
        context: textOrPayload.context || {},
      }
    : { text: textOrPayload, context: contextOrOptions || {} };
  const options = objectForm ? contextOrOptions : maybeOptions;
  return send(`${API_ROOT}/copilot/typeahead`, "POST", payload, options);
}

export function sendChat(messageOrPayload, options) {
  const payload = isRecord(messageOrPayload)
    ? messageOrPayload
    : { message: messageOrPayload };
  return send(`${API_ROOT}/ai/chat`, "POST", payload, options);
}

export function draftCopilotAction(instructionOrPayload, options) {
  const payload = isRecord(instructionOrPayload)
    ? instructionOrPayload
    : { instruction: instructionOrPayload };
  return send(`${API_ROOT}/copilot/act`, "POST", payload, options);
}

export function confirmCopilotAction(tokenOrDraft, options) {
  const confirmationToken = isRecord(tokenOrDraft)
    ? tokenOrDraft.confirmationToken
    : tokenOrDraft;

  // Deliberately send only the opaque, signed token. UI draft fields are never
  // trusted as confirmation input.
  return send(
    `${API_ROOT}/copilot/act/confirm`,
    "POST",
    { confirmationToken },
    options,
  );
}

export function createResource(payload, options) {
  return send(`${API_ROOT}/resources`, "POST", payload, options);
}

export function patchResource(resourceId, updates, options) {
  const id = endpointId(resourceId, "resourceId");
  return send(`${API_ROOT}/resources/${id}`, "PATCH", updates, options);
}

export function deleteResource(resourceId, options) {
  const id = endpointId(resourceId, "resourceId");
  return apiFetch(`${API_ROOT}/resources/${id}`, {
    ...(options || {}),
    method: "DELETE",
  });
}

export function createBooking(payloadOrResourceIds, options) {
  const payload = Array.isArray(payloadOrResourceIds)
    ? { resourceIds: payloadOrResourceIds }
    : payloadOrResourceIds;
  return send(`${API_ROOT}/bookings`, "POST", payload, options);
}

export function patchBooking(
  bookingId,
  actionOrPayload,
  ratingOrOptions,
  maybeOptions,
) {
  const id = endpointId(bookingId, "bookingId");
  const objectForm = isRecord(actionOrPayload);
  let payload;
  let options;

  if (objectForm) {
    payload = {
      action: actionOrPayload.action,
      ...(actionOrPayload.rating !== undefined ? { rating: actionOrPayload.rating } : {}),
    };
    options = ratingOrOptions;
  } else {
    const ratingWasOptions = isRecord(ratingOrOptions);
    payload = {
      action: actionOrPayload,
      ...(!ratingWasOptions && ratingOrOptions !== undefined
        ? { rating: ratingOrOptions }
        : {}),
    };
    options = ratingWasOptions ? ratingOrOptions : maybeOptions;
  }

  return send(`${API_ROOT}/bookings/${id}`, "PATCH", payload, options);
}

export function createProductionPlan(payload, options) {
  return send(`${API_ROOT}/production/plan`, "POST", payload, options);
}
