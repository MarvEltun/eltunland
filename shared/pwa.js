"use strict";

(() => {
  const nativeFetch = window.fetch.bind(window);
  const DB_NAME = "hub-pwa-v1";
  const DB_VERSION = 1;
  const SERVER_LISTS = {
    roam: "/roam/api/bootstrap",
    runs: "/runs/api/races",
    fitness: "/fitness/api/workouts",
  };
  let databasePromise;
  let activeUser;

  function database() {
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore("responses", { keyPath: "key" });
          db.createObjectStore("pending", { keyPath: "id" });
          db.createObjectStore("meta", { keyPath: "key" });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return databasePromise;
  }

  async function get(storeName, key) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const request = db.transaction(storeName).objectStore(storeName).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  async function getAll(storeName) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const request = db.transaction(storeName).objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function put(storeName, value) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).put(value);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  async function remove(storeName, key) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).delete(key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  function setStatus(message, error = false) {
    const status = document.getElementById("hub-sync-status");
    if (!status) return;
    status.textContent = message;
    status.classList.toggle("error", error);
  }

  function stable(value) {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
  }

  function userKey(path) {
    if (!activeUser) throw new Error("Sign in to use offline Hub data.");
    return `${activeUser}:${path}`;
  }

  async function setActiveUser(username) {
    if (!username || typeof username !== "string") return;
    const owner = await get("meta", "fuadLocalOwner");
    if (owner?.value && owner.value !== username) {
      const currentGarage = localStorage.getItem("myfuad.v1");
      if (currentGarage !== null) localStorage.setItem(`hub:fuad:${owner.value}`, currentGarage);
      const nextGarage = localStorage.getItem(`hub:fuad:${username}`);
      if (nextGarage === null) localStorage.removeItem("myfuad.v1");
      else localStorage.setItem("myfuad.v1", nextGarage);
    }
    await put("meta", { key: "fuadLocalOwner", value: username });
    activeUser = username;
    await put("meta", { key: "activeUser", value: username });
  }

  async function currentUser() {
    if (activeUser) return activeUser;
    const saved = await get("meta", "activeUser");
    activeUser = saved?.value || null;
    return activeUser;
  }

  function apiPath(url) {
    return `${url.pathname}${url.search}`;
  }

  function listPathFor(path) {
    if (path.startsWith("/roam/api/trips") || path.startsWith("/roam/api/stadiums")
      || path.startsWith("/roam/api/countries")) return SERVER_LISTS.roam;
    if (path.startsWith("/runs/api/races")) return SERVER_LISTS.runs;
    if (path.startsWith("/fitness/api/workouts") || path === "/fitness/api/goal") {
      return SERVER_LISTS.fitness;
    }
    return null;
  }

  function entityId(path) {
    const match = path.match(/\/(trips|stadiums|countries|races|workouts)\/([^/?]+)$/);
    return match ? decodeURIComponent(match[2]) : null;
  }

  function collectionName(path) {
    if (path.includes("/trips")) return "trips";
    if (path.includes("/stadiums")) return "stadiums";
    if (path.includes("/countries")) return "countries";
    if (path.includes("/races")) return "races";
    if (path.includes("/workouts")) return "workouts";
    return null;
  }

  function allowedOfflineWrite(path, method) {
    return (
      (/^\/roam\/api\/(trips|stadiums)(\/[^/]+)?$/.test(path)
        && (method === "POST" || method === "PUT" || method === "DELETE"))
      || (/^\/roam\/api\/countries\/[^/]+$/.test(path) && method === "PUT")
      || (/^\/runs\/api\/races(\/[^/]+)?$/.test(path)
        && (method === "POST" || method === "PUT" || method === "DELETE"))
      || (/^\/fitness\/api\/workouts(\/[^/]+)?$/.test(path)
        && (method === "POST" || method === "PUT" || method === "DELETE"))
      || (path === "/fitness/api/goal" && method === "PUT")
    );
  }

  async function rawCachedResponse(path) {
    return get("responses", userKey(path));
  }

  async function baseRecord(path) {
    const listPath = listPathFor(path);
    if (!listPath) return null;
    const row = await rawCachedResponse(listPath);
    const data = row?.data;
    if (!data) return null;
    if (path === "/fitness/api/goal") return { goal_minutes: data.goal_minutes };
    const id = entityId(path);
    const name = collectionName(path);
    if (!id || !name) return null;
    const record = (data[name] || []).find((item) => String(item.id) === id);
    return record ? structuredClone(record) : null;
  }

  async function baseRevision(path) {
    const listPath = listPathFor(path);
    if (!listPath) return null;
    const row = await rawCachedResponse(listPath);
    return Number.isInteger(row?.revision) ? row.revision : null;
  }

  function projected(path, record) {
    if (!record) return null;
    if (path.includes("/countries/")) return { status: record.status, notes: record.notes };
    const fields = path.includes("/trips/")
      ? ["id", "country_id", "title", "start_date", "end_date", "notes"]
      : path.includes("/stadiums/")
        ? ["id", "name", "location", "visited_on", "map_url", "notes", "latitude", "longitude"]
        : path.includes("/races/")
          ? ["id", "title", "city", "country", "kind", "distance_km", "race_date", "status",
            "finish_seconds", "notes", "series"]
          : path.includes("/workouts/")
            ? ["id", "day", "kind", "minutes", "distance_km", "effort", "notes"]
            : ["goal_minutes"];
    return Object.fromEntries(fields.filter((field) => field in record).map((field) => [field, record[field]]));
  }

  function responseRecord(operation) {
    const id = operation.tempId || entityId(operation.path);
    const body = operation.body || {};
    if (operation.path.includes("/countries/")) {
      return { country_id: entityId(operation.path), status: body.status, notes: body.notes };
    }
    if (operation.path === "/fitness/api/goal") {
      return { goal_minutes: body.minutes };
    }
    if (operation.path.startsWith("/runs/")) {
      const seconds = parseFinishTime(body.finish_time);
      const { finish_time: _finishTime, ...fields } = body;
      return { id, ...fields, finish_seconds: seconds };
    }
    return { id, ...body };
  }

  function parseFinishTime(value) {
    if (typeof value !== "string" || !value) return null;
    const parts = value.split(":").map(Number);
    if (parts.some((part) => !Number.isInteger(part) || part < 0)) return null;
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return null;
  }

  function applyPending(data, path, operations, idMap) {
    const result = structuredClone(data);
    for (const operation of operations) {
      if (operation.method === "POST" && operation.tempId && idMap.has(operation.tempId)) continue;
      let operationPath = new URL(operation.path, location.origin).pathname;
      for (const [temporary, actual] of idMap) {
        operationPath = operationPath.replace(encodeURIComponent(temporary), encodeURIComponent(actual));
      }
      if (listPathFor(operationPath) !== path) continue;
      if (operationPath === "/fitness/api/goal") {
        if (operation.method === "PUT") result.goal_minutes = operation.body.minutes;
        continue;
      }
      if (operationPath.includes("/countries/")) {
        const id = entityId(operationPath);
        const country = (result.countries || []).find((item) => item.id === id);
        if (country && operation.method === "PUT") {
          country.status = operation.body.status;
          country.notes = operation.body.notes;
        }
        continue;
      }
      const collection = collectionName(operationPath);
      const id = entityId(operationPath);
      if (!collection || !Array.isArray(result[collection])) continue;
      const localOperation = { ...operation, path: operationPath };
      if (operation.method === "POST") {
        result[collection] = result[collection].filter((item) => item.id !== operation.tempId);
        result[collection].push(responseRecord(localOperation));
      } else if (operation.method === "PUT") {
        const record = responseRecord(localOperation);
        const index = result[collection].findIndex((item) => String(item.id) === id);
        if (index >= 0) result[collection][index] = { ...result[collection][index], ...record };
        else result[collection].push(record);
      } else if (operation.method === "DELETE") {
        result[collection] = result[collection].filter((item) => String(item.id) !== id);
      }
    }
    return result;
  }

  async function pendingForUser() {
    const username = await currentUser();
    if (!username) return [];
    return (await getAll("pending")).filter((item) => item.owner === username);
  }

  function offlineResponse(value, status = 200) {
    return new Response(value === null ? null : JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8", "X-Hub-Offline": "true" },
    });
  }

  async function cacheApiResponse(url, response) {
    if (!response.ok) return;
    const contentType = response.headers.get("Content-Type") || "application/octet-stream";
    if (!contentType.includes("json") && !url.pathname.endsWith(".tsv")) return;
    const text = await response.clone().text();
    const data = contentType.includes("json") ? JSON.parse(text) : null;
    if (
      ["/api/me", "/api/login", "/api/pin"].includes(url.pathname)
      && data?.user?.username
    ) {
      await setActiveUser(data.user.username);
      renderSyncButton();
    }
    if (
      url.pathname.startsWith("/api/users")
      || url.pathname === "/api/me"
      || /\/api\/(?:token|credentials|status)(?:\/|$)/.test(url.pathname)
    ) return;
    const username = await currentUser();
    if (!username) return;
    await put("responses", {
      key: `${username}:${apiPath(url)}`,
      data,
      text: data === null ? text : null,
      contentType,
      revision: Number(response.headers.get("X-Hub-Revision")),
      savedAt: Date.now(),
    });
  }

  async function readOffline(url) {
    const path = apiPath(url);
    const row = await rawCachedResponse(path);
    if (!row) return null;
    if (row.data === null && typeof row.text === "string") {
      return new Response(row.text, {
        status: 200,
        headers: { "Content-Type": row.contentType, "X-Hub-Offline": "true" },
      });
    }
    const operations = await pendingForUser();
    const username = await currentUser();
    const aliases = (await getAll("meta"))
      .filter((entry) => entry.key.startsWith(`${username}:alias:`));
    const idMap = new Map(aliases.map((entry) => [
      entry.key.slice(`${username}:alias:`.length),
      entry.value.id,
    ]));
    return offlineResponse(applyPending(row.data, path, operations, idMap));
  }

  async function queueWrite(url, method, body) {
    if (!allowedOfflineWrite(url.pathname, method)) {
      throw new Error("This change needs a connection. It has not been saved.");
    }
    const username = await currentUser();
    if (!username) throw new Error("Sign in while online before making offline changes.");
    if (method !== "DELETE" && (!body || typeof body !== "object" || Array.isArray(body))) {
      throw new Error("This offline change has an invalid request body.");
    }
    const tempId = method === "POST" ? `offline-${crypto.randomUUID()}` : null;
    const opPath = apiPath(url);
    const targetPath = tempId ? `${opPath}/${encodeURIComponent(tempId)}` : opPath;
    const base = method === "POST" ? null : await baseRecord(opPath);
    const operation = {
      id: crypto.randomUUID(),
      owner: username,
      method,
      path: opPath,
      body,
      tempId,
      entity: targetPath,
      base: base === null ? null : projected(opPath, base),
      baseRevision: await baseRevision(opPath),
      createdAt: performance.timeOrigin + performance.now(),
    };
    await put("pending", operation);
    setStatus("Saved on this iPhone. Sync when the laptop is available.");
    if (method === "DELETE") return offlineResponse(null, 204);
    return offlineResponse(responseRecord(operation), method === "POST" ? 201 : 200);
  }

  async function readRequestBody(input, init) {
    if (init?.body === undefined) {
      if (input instanceof Request) {
        const text = await input.clone().text();
        return text ? JSON.parse(text) : null;
      }
      return null;
    }
    return typeof init.body === "string" ? JSON.parse(init.body) : init.body;
  }

  async function handleFetch(input, init) {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const method = (init?.method || request.method).toUpperCase();
    if (url.origin !== location.origin || !url.pathname.includes("/api/")) {
      return nativeFetch(input, init);
    }

    if (method === "GET") {
      let response;
      try {
        response = await nativeFetch(input, init);
      } catch (error) {
        const cached = await readOffline(url);
        if (cached) return cached;
        throw error;
      }
      try {
        await cacheApiResponse(url, response);
      } catch (error) {
        console.error("Could not cache Hub data for offline use:", error);
        setStatus("Offline cache unavailable; this response was not saved on this device.", true);
      }
      return response;
    }

    try {
      let outgoing = init;
      if (allowedOfflineWrite(url.pathname, method) && await currentUser()) {
        try {
          const headers = new Headers(init?.headers || request.headers);
          headers.set("X-Hub-Sync-Device", await deviceId());
          outgoing = { ...init, headers };
        } catch (error) {
          console.error("Could not label this device for conflict checks:", error);
        }
      }
      const response = await nativeFetch(input, outgoing);
      if (url.pathname === "/api/logout" && response.ok) {
        activeUser = null;
        await put("meta", { key: "activeUser", value: null });
        renderSyncButton();
      }
      return response;
    } catch (error) {
      const body = await readRequestBody(input, init);
      if (!allowedOfflineWrite(url.pathname, method)) throw error;
      return queueWrite(url, method, body);
    }
  }

  function itemForPath(list, path) {
    if (path === "/fitness/api/goal") return { goal_minutes: list.goal_minutes };
    const collection = collectionName(path);
    const id = entityId(path);
    return collection && id ? (list[collection] || []).find((record) => String(record.id) === id) || null : null;
  }

  async function fetchServerList(path) {
    const response = await nativeFetch(path, { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Laptop request failed (${response.status}).`);
    }
    const data = await response.json();
    await put("responses", {
      key: userKey(path),
      data,
      text: null,
      contentType: "application/json",
      revision: Number(response.headers.get("X-Hub-Revision")),
      savedAt: Date.now(),
    });
    return data;
  }

  function groupPending(operations) {
    const groups = new Map();
    for (const operation of operations) {
      const key = operation.entity;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(operation);
    }
    return groups;
  }

  async function deviceId() {
    const saved = await get("meta", "deviceId");
    if (saved?.value) return saved.value;
    const value = crypto.randomUUID();
    await put("meta", { key: "deviceId", value });
    return value;
  }

  function conflictPrompt(label) {
    return new Promise((resolve) => {
      const dialog = document.createElement("dialog");
      dialog.className = "hub-conflict";
      const heading = document.createElement("h2");
      heading.textContent = "This item changed on both devices";
      const description = document.createElement("p");
      description.textContent = `${label} has a newer laptop version and an offline iPhone version. Choose which one to keep.`;
      const laptop = document.createElement("button");
      laptop.type = "button";
      laptop.textContent = "Keep laptop";
      const device = document.createElement("button");
      device.type = "button";
      device.textContent = "Use iPhone";
      const actions = document.createElement("div");
      actions.className = "hub-conflict-actions";
      actions.append(laptop, device);
      dialog.append(heading, description, actions);
      document.body.append(dialog);
      const finish = (choice) => {
        dialog.close();
        dialog.remove();
        resolve(choice);
      };
      laptop.addEventListener("click", () => finish("laptop"));
      device.addEventListener("click", () => finish("device"));
      dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        finish("cancel");
      });
      dialog.showModal();
    });
  }

  function labelFor(group) {
    const first = group[0];
    const id = entityId(first.entity) || first.tempId;
    const noun = first.path.includes("/trips") ? "Trip"
      : first.path.includes("/stadiums") ? "Stadium"
        : first.path.includes("/countries") ? "Country"
          : first.path.includes("/races") ? "Race"
            : first.path.includes("/workouts") ? "Workout" : "Goal";
    return `${noun}${id ? ` ${id}` : ""}`;
  }

  async function resolveConflicts(groups, idMap) {
    const keep = new Set();
    const force = new Set();
    const discard = new Set();
    for (const [entity, operations] of groups) {
      const first = operations[0];
      if (!first.base || first.method === "POST") {
        keep.add(entity);
        continue;
      }
      let path = first.path;
      for (const [temporary, actual] of idMap) {
        path = path.replace(encodeURIComponent(temporary), encodeURIComponent(actual));
      }
      const listPath = listPathFor(path);
      if (!listPath) {
        keep.add(entity);
        continue;
      }
      const data = await fetchServerList(listPath);
      const current = itemForPath(data, path);
      const remote = projected(path, current);
      if (stable(remote) === stable(first.base)) {
        keep.add(entity);
        continue;
      }
      const choice = await conflictPrompt(labelFor(operations));
      if (choice === "device") {
        keep.add(entity);
        force.add(entity);
      }
      else if (choice === "laptop") discard.add(entity);
      else if (choice === "cancel") throw new Error("Sync paused; pending changes are still on this iPhone.");
    }
    return { keep, force, discard };
  }

  async function applyOperation(operation, idMap, revisionMap, force = false) {
    let path = operation.path;
    for (const [temporary, actual] of idMap) {
      path = path.replace(encodeURIComponent(temporary), encodeURIComponent(actual));
    }
    const body = operation.body ? structuredClone(operation.body) : undefined;
    if (body) {
      for (const [temporary, actual] of idMap) {
        for (const key of ["trip_id", "stadium_id", "race_id", "workout_id"]) {
          if (body[key] === temporary) body[key] = actual;
        }
      }
    }
    const headers = body ? { "Content-Type": "application/json" } : {};
    headers["X-Hub-Sync-Operation"] = operation.id;
    headers["X-Hub-Sync-Device"] = await deviceId();
    const operationId = entityId(operation.path);
    const revision = operation.baseRevision ?? (operationId ? revisionMap.get(operationId) : null);
    if (revision !== null && operation.method !== "POST") {
      headers["X-Hub-Sync-Revision"] = String(revision);
      headers["X-Hub-Sync-Entity"] = path;
      if (force) headers["X-Hub-Sync-Force"] = "1";
    }
    const response = await nativeFetch(path, {
      method: operation.method,
      credentials: "same-origin",
      cache: "no-store",
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.status === 404 && operation.method === "DELETE") {
      await remove("pending", operation.id);
      return;
    }
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      if (response.status === 409) {
        const conflict = new Error(data.error || `A conflict occurred syncing ${labelFor([operation])}.`);
        conflict.offlineConflict = true;
        throw conflict;
      }
      throw new Error(data.error || `Could not sync ${labelFor([operation])} (${response.status}).`);
    }
    if (operation.method === "POST" && operation.tempId) {
      const result = await response.json();
      if (result.id) {
        idMap.set(operation.tempId, result.id);
        const revision = Number(response.headers.get("X-Hub-Revision"));
        if (Number.isInteger(revision)) revisionMap.set(operation.tempId, revision);
        await put("meta", {
          key: `${operation.owner}:alias:${operation.tempId}`,
          value: { id: result.id, revision },
        });
      }
    }
    await remove("pending", operation.id);
  }

  async function rebasePendingEntity(entity, username, idMap) {
    const remaining = (await pendingForUser()).filter((operation) => operation.entity === entity);
    if (!remaining.length) return;
    let path = remaining[0].path;
    for (const [temporary, actual] of idMap) {
      path = path.replace(encodeURIComponent(temporary), encodeURIComponent(actual));
    }
    const listPath = listPathFor(path);
    if (!listPath) return;
    const data = await fetchServerList(listPath);
    const current = itemForPath(data, path);
    const base = projected(path, current);
    const row = await rawCachedResponse(listPath);
    for (const operation of remaining) {
      operation.base = base;
      operation.baseRevision = Number.isInteger(row?.revision) ? row.revision : null;
      await put("pending", operation);
    }
  }

  async function syncOperations(username) {
    const operations = (await pendingForUser()).sort((a, b) => a.createdAt - b.createdAt);
    if (!operations.length) return { count: 0, needsReload: false, discarded: 0 };
    const idMap = new Map();
    const revisionMap = new Map();
    const aliases = (await getAll("meta"))
      .filter((entry) => entry.key.startsWith(`${username}:alias:`));
    for (const alias of aliases) {
      const temporary = alias.key.slice(`${username}:alias:`.length);
      idMap.set(temporary, alias.value.id);
      revisionMap.set(temporary, alias.value.revision);
    }
    const { keep, force, discard: discardFromConflict } = await resolveConflicts(
      groupPending(operations),
      idMap,
    );
    let synced = 0;
    let mappedNewIds = false;
    const discard = new Set(discardFromConflict);
    let discarded = discard.size;
    for (const pendingOperation of operations) {
      const operation = await get("pending", pendingOperation.id);
      if (!operation) continue;
      if (!keep.has(operation.entity) || discard.has(operation.entity)) {
        if (!discard.has(operation.entity)) {
          discard.add(operation.entity);
          discarded += 1;
        }
        await remove("pending", operation.id);
        continue;
      }
      try {
        await applyOperation(operation, idMap, revisionMap, force.has(operation.entity));
      } catch (error) {
        if (error.offlineConflict) {
          const choice = await conflictPrompt(labelFor([operation]));
          if (choice === "laptop") {
            discard.add(operation.entity);
            discarded += 1;
            await remove("pending", operation.id);
            continue;
          }
          if (choice === "device") {
            force.add(operation.entity);
            await applyOperation(operation, idMap, revisionMap, true);
            synced += 1;
            continue;
          }
          throw new Error("Sync paused; pending changes are still on this iPhone.");
        }
        setStatus(error.message, true);
        throw error;
      }
      synced += 1;
      if ([...idMap.keys()].some((temporary) => operation.entity.includes(temporary))) {
        mappedNewIds = true;
      }
      await rebasePendingEntity(operation.entity, username, idMap);
    }

    for (const path of new Set(operations.map((operation) => listPathFor(operation.path)).filter(Boolean))) {
      await fetchServerList(path);
    }
    return { count: synced, needsReload: mappedNewIds, discarded };
  }

  async function readFuadLocal() {
    const text = localStorage.getItem("myfuad.v1");
    return text ? JSON.parse(text) : null;
  }

  async function syncFuad(username) {
    const owner = await get("meta", "fuadLocalOwner");
    if (owner?.value !== username) {
      throw new Error("MyFuad local data is assigned to a different Hub profile.");
    }
    const response = await nativeFetch("/api/offline/fuad", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Could not read the laptop MyFuad backup (${response.status}).`);
    }
    const remote = await response.json();
    const baselineRow = await get("meta", `${username}:fuad`);
    const baseline = baselineRow?.value || null;
    const local = await readFuadLocal();
    const localChanged = stable(local) !== stable(baseline?.payload ?? null);
    const remoteChanged = remote.revision !== (baseline?.revision ?? 0)
      || stable(remote.payload) !== stable(baseline?.payload ?? null);

    if (stable(local) === stable(remote.payload)) {
      await put("meta", {
        key: `${username}:fuad`,
        value: { payload: remote.payload, revision: remote.revision },
      });
      return false;
    }

    if (local === null && remote.payload === null) {
      await put("meta", { key: `${username}:fuad`, value: { payload: null, revision: 0 } });
      return false;
    }
    if (local === null || (!localChanged && remoteChanged)) {
      if (remote.payload !== null) {
        const text = JSON.stringify(remote.payload);
        localStorage.setItem("myfuad.v1", text);
        localStorage.setItem(`hub:fuad:${username}`, text);
      }
      await put("meta", { key: `${username}:fuad`, value: { payload: remote.payload, revision: remote.revision } });
      return remote.payload !== null;
    }

    let useLocal = localChanged;
    if (localChanged && remoteChanged && stable(local) !== stable(remote.payload)) {
      const choice = await conflictPrompt("MyFuad garage");
      if (choice === "cancel") throw new Error("Sync paused; pending MyFuad changes are still on this device.");
      useLocal = choice === "device";
    }
    if (!useLocal) {
      if (remote.payload !== null) {
        const text = JSON.stringify(remote.payload);
        localStorage.setItem("myfuad.v1", text);
        localStorage.setItem(`hub:fuad:${username}`, text);
      }
      await put("meta", { key: `${username}:fuad`, value: { payload: remote.payload, revision: remote.revision } });
      return remote.payload !== null;
    }

    if (!local || !Number.isInteger(local.version)) {
      throw new Error("The MyFuad data on this device is not a valid backup.");
    }
    const write = await nativeFetch("/api/offline/fuad", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload: local, expected_revision: remote.revision }),
    });
    if (!write.ok) {
      const data = await write.json().catch(() => ({}));
      throw new Error(data.error || `Could not save the MyFuad backup (${write.status}).`);
    }
    const saved = await write.json();
    const text = JSON.stringify(saved.payload);
    localStorage.setItem(`hub:fuad:${username}`, text);
    await put("meta", {
      key: `${username}:fuad`,
      value: { payload: saved.payload, revision: saved.revision },
    });
    return false;
  }

  async function syncNow() {
    const username = await currentUser();
    if (!username) throw new Error("Sign in while online before syncing Hub.");
    const button = document.getElementById("hub-sync-button");
    if (button) button.disabled = true;
    setStatus("Syncing with the laptop...");
    try {
      const changedFuad = await syncFuad(username);
      const result = await syncOperations(username);
      const remaining = (await pendingForUser()).length;
      if (remaining) setStatus(`${remaining} change(s) still need attention.`);
      else if (result.discarded) {
        setStatus(`Kept the laptop version for ${result.discarded} conflicting item(s).`);
      } else setStatus("Everything is synced with the laptop.");
      if (changedFuad && location.pathname.startsWith("/fuad/")) {
        location.reload();
      } else if (result.needsReload) {
        setStatus("New records synced. Reloading to refresh their IDs.");
        window.setTimeout(() => location.reload(), 500);
      } else if (changedFuad) {
        setStatus("MyFuad was updated from the laptop. Open it to see the changes.");
      }
      return result.count;
    } finally {
      if (button) button.disabled = false;
    }
  }

  function renderSyncButton() {
    let button = document.getElementById("hub-sync-button");
    if (!activeUser) {
      button?.remove();
      document.getElementById("hub-sync-status")?.remove();
      return;
    }
    if (button) return;
    button = document.createElement("button");
    button.id = "hub-sync-button";
    button.type = "button";
    button.textContent = "Sync to laptop";
    const status = document.createElement("span");
    status.id = "hub-sync-status";
    status.setAttribute("role", "status");
    const container = document.createElement("aside");
    container.id = "hub-offline-controls";
    container.append(button, status);
    document.body.append(container);
    button.addEventListener("click", async () => {
      try {
        await syncNow();
      } catch (error) {
        setStatus(error.message, true);
      }
    });
    updateConnectionStatus();
  }

  function updateConnectionStatus() {
    const status = document.getElementById("hub-sync-status");
    if (status && !document.getElementById("hub-sync-button")?.disabled) {
      status.textContent = navigator.onLine ? "Connected" : "Offline — changes stay on this device";
      status.classList.toggle("offline", !navigator.onLine);
    }
  }

  async function initialize() {
    const saved = await get("meta", "activeUser");
    activeUser = saved?.value || null;
    try {
      const response = await nativeFetch("/api/me", { credentials: "same-origin", cache: "no-store" });
      if (response.ok) {
        const data = await response.json();
        await setActiveUser(data.user.username);
      }
    } catch (error) {
      if (!activeUser) console.info("Hub is offline; no signed-in offline profile is available.");
    }
    renderSyncButton();
    if (activeUser && "serviceWorker" in navigator && location.protocol === "https:") {
      navigator.serviceWorker.register("/service-worker.js", { scope: "/" }).catch((error) => {
        console.error("Could not register the Hub offline worker:", error);
        setStatus(`Offline pages could not be installed: ${error.message}`, true);
      });
    }
    window.addEventListener("online", updateConnectionStatus);
    window.addEventListener("offline", updateConnectionStatus);
  }

  window.fetch = handleFetch;
  initialize().catch((error) => {
    console.error("Could not initialize Hub offline storage:", error);
    setStatus("Offline storage could not be opened.", true);
  });
})();
