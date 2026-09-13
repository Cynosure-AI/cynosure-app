export interface PromptSmartTag {
  name: string;
  label: string;
  description: string;
}

export const PROMPT_SMART_TAGS: PromptSmartTag[] = [
  {
    name: "userName",
    label: "User name",
    description: "The name configured for the current user in General settings.",
  },
  {
    name: "currentDateTime",
    label: "Current date/time",
    description: "Current date and time in the server locale and timezone.",
  },
  {
    name: "currentDate",
    label: "Current date",
    description: "Current date in the server locale and timezone.",
  },
  {
    name: "currentTime",
    label: "Current time",
    description: "Current time in the server locale and timezone.",
  },
  {
    name: "localDateTime",
    label: "Local date/time",
    description: "Current date and time in the server locale and timezone.",
  },
  {
    name: "localDate",
    label: "Local date",
    description: "Current date in the server locale and timezone.",
  },
  {
    name: "localTime",
    label: "Local time",
    description: "Current time in the server locale and timezone.",
  },
  {
    name: "isoDate",
    label: "ISO date",
    description: "Current UTC date as YYYY-MM-DD.",
  },
  {
    name: "isoTime",
    label: "ISO time",
    description: "Current UTC time as HH:mm:ss.",
  },
  {
    name: "timezone",
    label: "Timezone",
    description: "Resolved server timezone.",
  },
  {
    name: "locale",
    label: "Locale",
    description: "Resolved server locale.",
  },
  {
    name: "agentId",
    label: "Agent ID",
    description: "Current agent identifier.",
  },
  {
    name: "agentName",
    label: "Agent name",
    description: "Current agent display name.",
  },
  {
    name: "agentInternalName",
    label: "Agent internal name",
    description: "Current agent orchestration name.",
  },
  {
    name: "providerId",
    label: "Provider ID",
    description: "Resolved provider for this execution.",
  },
  {
    name: "model",
    label: "Model",
    description: "Resolved model for this execution.",
  },
  {
    name: "conversationId",
    label: "Conversation ID",
    description: "Conversation identifier for the current run.",
  },
  {
    name: "selectedMemFolderNames",
    label: "Selected memory folders",
    description: "Names of the memory folders provided to this execution.",
  },
];

export function formatPromptSmartTag(name: string): string {
  return `{{${name}}}`;
}
