import { listAgents } from '../db/repositories/agents.repo.js';
import { listGroups } from '../db/repositories/groups.repo.js';
import { listLinkedMessages, listUnlinkedMessages } from '../db/repositories/telegramMessages.repo.js';

export interface DebugSnapshot {
  groups: Awaited<ReturnType<typeof listGroups>>;
  agents: Awaited<ReturnType<typeof listAgents>>;
  unlinkedMessages: Awaited<ReturnType<typeof listUnlinkedMessages>>;
  linkedMessages: Awaited<ReturnType<typeof listLinkedMessages>>;
}

export async function getDebugSnapshot(): Promise<DebugSnapshot> {
  const [groups, agents, unlinkedMessages, linkedMessages] = await Promise.all([
    listGroups(),
    listAgents(),
    listUnlinkedMessages(),
    listLinkedMessages(),
  ]);
  return { groups, agents, unlinkedMessages, linkedMessages };
}
