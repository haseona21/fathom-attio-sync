import type { CRM, Deal, DealFile, DealLink, Person } from "../types/crm.js";
import { ATTIO_API_KEY } from "./config.js";
import { AttioError, logger } from "./errors.js";
import { fetchWithRetry } from "./http.js";

const BASE = "https://api.attio.com/v2";
const ATTIO_ATTRIBUTE = "fathom_links";
const DEALS_OBJECT = "magic";

function headers() {
  return {
    Authorization: `Bearer ${ATTIO_API_KEY()}`,
    "Content-Type": "application/json",
  };
}

async function attioGet(path: string): Promise<Record<string, unknown> | null> {
  const resp = await fetchWithRetry(`${BASE}${path}`, { headers: headers() });
  if (resp.ok) return resp.json() as Promise<Record<string, unknown>>;
  logger.warn(`Attio GET ${path} returned ${resp.status}: ${await resp.text()}`);
  return null;
}

async function attioPost(path: string, body: unknown): Promise<Record<string, unknown> | null> {
  const resp = await fetchWithRetry(`${BASE}${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (resp.ok) return resp.json() as Promise<Record<string, unknown>>;
  logger.warn(`Attio POST ${path} returned ${resp.status}: ${await resp.text()}`);
  return null;
}

async function attioPatch(path: string, body: unknown): Promise<Record<string, unknown> | null> {
  const resp = await fetchWithRetry(`${BASE}${path}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (resp.ok) return resp.json() as Promise<Record<string, unknown>>;
  logger.warn(`Attio PATCH ${path} returned ${resp.status}: ${await resp.text()}`);
  return null;
}

// Helpers to extract nested Attio values
function valuesFrom(data: Record<string, unknown>): Record<string, unknown[]> {
  const d = data.data as Record<string, unknown> | undefined;
  return (d?.values ?? {}) as Record<string, unknown[]>;
}

function firstVal(values: Record<string, unknown[]>, field: string, key = "value"): string {
  const entries = values[field] as Record<string, unknown>[] | undefined;
  if (!entries?.length) return "";
  return String(entries[0][key] ?? "");
}

function firstRecordRef(values: Record<string, unknown[]>, field: string): string {
  const entries = values[field] as Record<string, unknown>[] | undefined;
  if (!entries?.length) return "";
  return String(entries[0].target_record_id ?? "");
}

export function createAttioCRM(): CRM {
  return {
    async findPersonByEmail(email) {
      const filters = [
        { email_addresses: email.toLowerCase() },
        { email_addresses: { original_email_address: { $eq: email.toLowerCase() } } },
      ];
      for (const filter of filters) {
        const result = await attioPost("/objects/people/records/query", { filter });
        if (!result) continue;
        const data = (result.data as Record<string, unknown>[]) ?? [];
        const ids = data.map((r) => String((r.id as Record<string, string>).record_id));
        if (ids.length) return ids;
      }
      return [];
    },

    async getPersonDetails(personRecordId) {
      const data = await attioGet(`/objects/people/records/${personRecordId}`);
      if (!data) return null;

      const values = valuesFrom(data);
      const nameEntries = values.name as Record<string, unknown>[] | undefined;
      const name = nameEntries?.length
        ? String(nameEntries[0].full_name ?? nameEntries[0].value ?? "")
        : "";

      const emailEntries = values.email_addresses as Record<string, unknown>[] | undefined;
      const email = emailEntries?.length
        ? String(emailEntries[0].email_address ?? emailEntries[0].value ?? "")
        : "";

      return { recordId: personRecordId, name, email };
    },

    async getAllPersonEmails(email) {
      const personIds = await this.findPersonByEmail(email);
      if (!personIds.length) return [email];

      const data = await attioGet(`/objects/people/records/${personIds[0]}`);
      if (!data) return [email];

      const values = valuesFrom(data);
      const entries = values.email_addresses as Record<string, unknown>[] | undefined;
      if (!entries?.length) return [email];

      const emails = entries
        .map((e) => String(e.email_address ?? e.value ?? "").toLowerCase())
        .filter(Boolean);
      return emails.length ? emails : [email];
    },

    async getPersonLinkedin(personRecordId) {
      const data = await attioGet(`/objects/people/records/${personRecordId}`);
      if (!data) return "";
      return firstVal(valuesFrom(data), "linkedin");
    },

    async findCompanyByDomain(domain) {
      const filters = [
        { domains: domain.toLowerCase() },
        { domains: { domain: { $eq: domain.toLowerCase() } } },
      ];
      for (const filter of filters) {
        const result = await attioPost("/objects/companies/records/query", { filter });
        if (!result) continue;
        const data = (result.data as Record<string, unknown>[]) ?? [];
        const ids = data.map((r) => String((r.id as Record<string, string>).record_id));
        if (ids.length) return ids;
      }
      return [];
    },

    async getCompanyName(companyRecordId) {
      const data = await attioGet(`/objects/companies/records/${companyRecordId}`);
      if (!data) return "";
      return firstVal(valuesFrom(data), "name");
    },

    async getCompanyDescription(companyRecordId) {
      const data = await attioGet(`/objects/companies/records/${companyRecordId}`);
      if (!data) return "";
      return firstVal(valuesFrom(data), "description");
    },

    async getCompanyFathomLink(companyRecordId) {
      const data = await attioGet(`/objects/companies/records/${companyRecordId}`);
      if (!data) return "";
      const fullValue = firstVal(valuesFrom(data), ATTIO_ATTRIBUTE);
      if (!fullValue) return "";
      const parts = fullValue.split(",").map((p) => p.trim());
      return parts[parts.length - 1] ?? "";
    },

    async findDealsByPerson(personRecordId) {
      const result = await attioPost(`/objects/${DEALS_OBJECT}/records/query`, {
        filter: { primary_contact: { target_record_id: { $eq: personRecordId } } },
      });
      if (!result) return [];
      return ((result.data as Record<string, unknown>[]) ?? []).map((r) => parseDealRecord(r));
    },

    async findDealsByCompany(companyRecordId) {
      const result = await attioPost(`/objects/${DEALS_OBJECT}/records/query`, {
        filter: { company: { target_record_id: { $eq: companyRecordId } } },
      });
      if (!result) return [];
      return ((result.data as Record<string, unknown>[]) ?? []).map((r) => parseDealRecord(r));
    },

    async getDealDetails(dealRecordId) {
      const data = await attioGet(`/objects/${DEALS_OBJECT}/records/${dealRecordId}`);
      if (!data) return null;
      const values = valuesFrom(data);

      const dealStage = parseStatusTitle(values, "deal_stage");

      return {
        recordId: dealRecordId,
        dealName: firstVal(values, "deal_name"),
        dealStage,
        companyRecordId: firstRecordRef(values, "company"),
        primaryContactRecordId: firstRecordRef(values, "primary_contact"),
      };
    },

    async updateDealStage(dealRecordId, stageTitle) {
      logger.info(`Updating deal ${dealRecordId} stage to '${stageTitle}'`);
      const result = await attioPatch(`/objects/${DEALS_OBJECT}/records/${dealRecordId}`, {
        data: { values: { deal_stage: stageTitle } },
      });
      if (!result) {
        throw new AttioError(`Failed to update deal ${dealRecordId} stage to '${stageTitle}'`);
      }
    },

    async getDealLinkedRecords(dealRecordId) {
      const dealData = await attioGet(`/objects/${DEALS_OBJECT}/records/${dealRecordId}`);
      if (!dealData) return [];

      const values = valuesFrom(dealData);
      const linkRefs = values.links as Record<string, unknown>[] | undefined;
      if (!linkRefs?.length) return [];

      const results: DealLink[] = [];
      for (const ref of linkRefs) {
        const linkRecordId = String(ref.target_record_id ?? "");
        if (!linkRecordId) continue;

        const linkData = await attioGet(`/objects/links/records/${linkRecordId}`);
        if (!linkData) continue;

        const linkValues = valuesFrom(linkData);
        const url = firstVal(linkValues, "url");
        const typeEntries = linkValues.type as Record<string, unknown>[] | undefined;
        const linkType = typeEntries?.length
          ? String((typeEntries[0].option as Record<string, string>)?.title ?? "")
          : "";
        const title = firstVal(linkValues, "url_title");

        results.push({ url, type: linkType, title });
      }
      return results;
    },

    async getDealDeckUrl(dealRecordId) {
      const links = await this.getDealLinkedRecords(dealRecordId);
      const deck = links.find((l) => l.type === "Deck");
      return deck?.url ?? "";
    },

    async getDealFiles(dealRecordId) {
      const resp = await fetchWithRetry(
        `${BASE}/files?object=${DEALS_OBJECT}&record_id=${dealRecordId}`,
        { headers: headers() },
      );
      if (!resp.ok) {
        logger.warn(`Attio files list for ${dealRecordId} returned ${resp.status}`);
        return [];
      }
      const data = (await resp.json()) as Record<string, unknown>;
      const items = (data.data as Record<string, unknown>[]) ?? [];

      const files: DealFile[] = [];
      for (const item of items) {
        const fileType = String(item.file_type ?? "");
        if (fileType !== "file" && fileType !== "connected-file") continue;
        const id = item.id as Record<string, string> | undefined;
        files.push({
          name: String(item.name ?? ""),
          fileId: id?.file_id ?? "",
          fileType: fileType as DealFile["fileType"],
        });
      }
      return files;
    },

    async getFileDownloadUrl(fileId) {
      // Follow redirect to get signed URL
      const resp = await fetch(`${BASE}/files/${fileId}/download`, {
        headers: headers(),
        redirect: "manual",
      });
      const location = resp.headers.get("location");
      if (location) return location;

      // Some responses may be 200 with a direct URL
      if (resp.ok) {
        const data = (await resp.json()) as Record<string, unknown>;
        return String(data.url ?? data.download_url ?? "");
      }

      logger.warn(`Attio file download for ${fileId} returned ${resp.status}`);
      return "";
    },

    async getCurrentValue(objectType, recordId) {
      const data = await attioGet(`/objects/${objectType}/records/${recordId}`);
      if (!data) return "";
      return firstVal(valuesFrom(data), ATTIO_ATTRIBUTE);
    },

    async appendLink(objectType, recordId, newEntry) {
      const current = await this.getCurrentValue(objectType, recordId);
      if (current.includes(newEntry)) {
        logger.debug(`Link already exists for ${objectType}/${recordId}, skipping.`);
        return false;
      }
      const updated = current ? `${current}, ${newEntry}` : newEntry;
      const result = await attioPatch(`/objects/${objectType}/records/${recordId}`, {
        data: { values: { [ATTIO_ATTRIBUTE]: updated } },
      });
      return result !== null;
    },
  };
}

function parseStatusTitle(values: Record<string, unknown[]>, field: string): string {
  const entries = values[field] as Record<string, unknown>[] | undefined;
  if (!entries?.length) return "";
  const status = entries[0].status as Record<string, unknown> | undefined;
  return String(status?.title ?? "");
}

function parseDealRecord(record: Record<string, unknown>): Deal {
  const values = (record.values ?? {}) as Record<string, unknown[]>;
  const id = record.id as Record<string, string>;
  return {
    recordId: id.record_id,
    dealName: firstVal(values, "deal_name"),
    dealStage: parseStatusTitle(values, "deal_stage"),
    companyRecordId: firstRecordRef(values, "company"),
    primaryContactRecordId: firstRecordRef(values, "primary_contact"),
  };
}
