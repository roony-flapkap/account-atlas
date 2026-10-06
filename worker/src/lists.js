// Making a HubSpot list from what the Atlas shows: the records of one type
// on a canvas, in a finding, or in a SQL result. For the editors only, as
// the deletes are (edit.js). A list is the one thing the Atlas creates in
// HubSpot: a static ("MANUAL") list, which changes no record, and which
// HubSpot can restore for 90 days after it is deleted.
//
// In steps, so that a big list keeps to the free plan's limits (10 ms of CPU
// and 50 subrequests a call):
//   /api/lists/keys    a SQL result's records of one type, the query run in
//                      full (sql.js does the picking, in D1)
//   /api/lists/create  the empty list, with a ticket for filling it
//   /api/lists/add     up to 10,000 ids into it a call
// Records can only be added to a list the Atlas made, by the editor who made
// it, within the hour: the ticket says which, so no other list in HubSpot
// can be reached through here, and nothing about it is kept in D1.

import { hubspotClient, KIND_OF } from "./hubspot.js";
import { canEdit } from "./edit.js";
import { signTicket, readTicket } from "./auth.js";
import { sqlKeys } from "./sql.js";
import { HttpError } from "./errors.js";

const ADD_MAX = 10000, NAME_MAX = 100, TICKET_S = 3600;
const SOURCES = ["canvas", "finding", "canvas-finding", "sql"];

function mustEdit(env, user){
  if (!canEdit(env, user)) throw new HttpError(403, "not_editor", "only the Atlas's editors may make lists in HubSpot");
}
function typeOf(t){
  t = String(t || "");
  if (!KIND_OF[t]) throw new HttpError(400, "bad_input", "a record type is 0-1, 0-2, 0-3 or 0-136");
  return t;
}
const counted = a => Array.isArray(a) ? a.length : 0;

// a SQL result's records of one type, every row of it
export async function listKeys(env, user, b){
  mustEdit(env, user);
  return sqlKeys(env, user, b.sql, b.columns, typeOf(b.type));
}

export async function createList(env, user, b){
  mustEdit(env, user);
  const type = typeOf(b.type);
  const name = String(b.name || "").replace(/\s+/g, " ").trim();
  if (!name) throw new HttpError(400, "bad_input", "name the list");
  if (name.length > NAME_MAX) throw new HttpError(400, "bad_input", "a list's name is at most " + NAME_MAX + " characters");
  // where it came from, for the audit only
  const s = b.source && typeof b.source === "object" ? b.source : {};
  const source = { kind: SOURCES.indexOf(s.kind) >= 0 ? s.kind : "other" };
  if (s.id) source.id = String(s.id).slice(0, 60);
  if (s.name) source.name = String(s.name).slice(0, 120);
  if (s.sql) source.sql = String(s.sql).slice(0, 2000);

  const hs = hubspotClient(env, { writes: true });
  let r;
  try { r = await hs.createList(name, type); }
  catch(e){
    if (e.sub === "ILS.DUPLICATE_LIST_NAMES") throw new HttpError(409, "name_taken", "HubSpot already has a list called “" + name + "”");
    if (e.code === "missing_scope") throw new HttpError(403, "missing_scope", "the Atlas's HubSpot app may not make lists (it needs the crm.lists.write scope)");
    throw e;
  }
  const listId = String((r && r.list && r.list.listId) || "");
  if (!/^\d{1,20}$/.test(listId)) throw new HttpError(502, "hubspot_error", "HubSpot made the list but gave no id for it");
  await env.APP.prepare("INSERT INTO audit (at, email, action, detail) VALUES (?1, ?2, 'hs_list', ?3)")
    .bind(new Date().toISOString(), user.email, JSON.stringify({ listId, name, type, planned: Math.max(0, Math.floor(Number(b.planned) || 0)), source })).run();
  const ticket = await signTicket(env, "list", { l: listId, t: type, e: user.email }, TICKET_S);
  return { listId, name, type, ticket };
}

export async function addToList(env, user, b){
  mustEdit(env, user);
  const t = await readTicket(env, "list", b.ticket);
  if (!t || t.e !== user.email) throw new HttpError(403, "bad_ticket", "that is not a list made here in the last hour");
  if (!Array.isArray(b.ids)) throw new HttpError(400, "bad_input", "ids is a list of record ids");
  const ids = [...new Set(b.ids.map(String))];
  if (ids.some(id => !/^\d{1,20}$/.test(id))) throw new HttpError(400, "bad_input", "a record id is digits");
  if (ids.length > ADD_MAX) throw new HttpError(400, "too_many", "at most " + ADD_MAX.toLocaleString("en-US") + " records a call");
  if (!ids.length) return { added: 0, missing: 0 };
  const hs = hubspotClient(env, { writes: true });
  let r;
  try { r = await hs.addToList(t.l, ids); }
  catch(e){
    if (e.code === "missing_scope") throw new HttpError(403, "missing_scope", "the Atlas's HubSpot app may not add to lists (it needs the crm.lists.write scope)");
    if (e.code === "not_found") throw new HttpError(404, "not_found", "the list is no longer in HubSpot");
    throw e;
  }
  // HubSpot spells it recordsIdsAdded, and leaves out an empty list
  r = r || {};
  return { added: counted(r.recordsIdsAdded) + counted(r.recordIdsAdded), missing: counted(r.recordIdsMissing) };
}
