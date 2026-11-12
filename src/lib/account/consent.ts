/** The privacy notice / terms version a consent record refers to. Bump it when the notice changes materially (DPDP Act 2023). */
export const PRIVACY_NOTICE_VERSION = "2026-11";
export const CONSENT_PURPOSES = ["terms_privacy", "marketing"] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];
