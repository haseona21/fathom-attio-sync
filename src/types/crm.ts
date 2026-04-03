export interface Person {
  recordId: string;
  name: string;
  email: string;
}

export interface Company {
  recordId: string;
  name: string;
}

export interface Deal {
  recordId: string;
  dealName: string;
  dealStage: string;
  companyRecordId: string;
  primaryContactRecordId: string;
}

export interface DealLink {
  url: string;
  type: string;
  title: string;
}

export interface DealFile {
  name: string;
  fileId: string;
  fileType: "file" | "connected-file" | "folder" | "connected-folder";
}

export interface CRM {
  // People
  findPersonByEmail(email: string): Promise<string[]>;
  getPersonDetails(personRecordId: string): Promise<Person | null>;
  getAllPersonEmails(email: string): Promise<string[]>;
  getPersonLinkedin(personRecordId: string): Promise<string>;

  // Companies
  findCompanyByDomain(domain: string): Promise<string[]>;
  getCompanyName(companyRecordId: string): Promise<string>;
  getCompanyDescription(companyRecordId: string): Promise<string>;
  getCompanyTeam(companyRecordId: string): Promise<{ name: string; linkedin: string }[]>;
  getCompanyFathomLink(companyRecordId: string): Promise<string>;

  // Deals
  findDealsByPerson(personRecordId: string): Promise<Deal[]>;
  findDealsByCompany(companyRecordId: string): Promise<Deal[]>;
  getDealDetails(dealRecordId: string): Promise<Deal | null>;
  updateDealStage(dealRecordId: string, stageTitle: string): Promise<void>;
  getDealLinkedRecords(dealRecordId: string): Promise<DealLink[]>;
  getDealDeckUrl(dealRecordId: string): Promise<string>;

  // Files
  getDealFiles(dealRecordId: string): Promise<DealFile[]>;
  getFileDownloadUrl(fileId: string): Promise<string>;

  // Fathom links (used by fathom-sync)
  getCurrentValue(objectType: string, recordId: string): Promise<string>;
  appendLink(objectType: string, recordId: string, newEntry: string): Promise<boolean>;
}

export function extractDomain(email: string): string | null {
  const match = (email || "").match(/@([\w.\-]+)$/);
  return match ? match[1].toLowerCase() : null;
}

export const IGNORED_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com",
  "yahoo.com", "icloud.com", "me.com", "mac.com", "live.com",
  "msn.com", "protonmail.com", "pm.me",
]);
