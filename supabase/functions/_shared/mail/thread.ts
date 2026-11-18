// Which conversation an inbound mail belongs to (email spec §3 "קליטה" step 4):
// 1. a stored message whose Message-ID is in the mail's In-Reply-To/References; 2. the contact's email conversation
// that is not closed; 3. a new open one. A matched closed conversation is reopened.
export interface ThreadDb {
  convByRefs(refs: string[]): Promise<{ id: string; status: string } | null>;
  openEmailConv(contactId: string): Promise<{ id: string; status: string } | null>;
  newEmailConv(contactId: string, subject: string | null): Promise<string>;
  reopen(convId: string): Promise<void>;
}

export async function pickConversation(db: ThreadDb, contactId: string, refs: string[], subject: string | null):
  Promise<{ id: string; isNew: boolean; reopened: boolean }> {
  const byRef = refs.length ? await db.convByRefs(refs) : null;
  if (byRef) {
    if (byRef.status !== "closed") return { id: byRef.id, isNew: false, reopened: false };
    await db.reopen(byRef.id);
    return { id: byRef.id, isNew: false, reopened: true };
  }
  const open = await db.openEmailConv(contactId);
  if (open) return { id: open.id, isNew: false, reopened: false };
  return { id: await db.newEmailConv(contactId, subject), isNew: true, reopened: false };
}
