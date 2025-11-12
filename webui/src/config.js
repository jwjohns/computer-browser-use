const getWindow = () => (typeof window === "undefined" ? undefined : window);

const resolveAgentBaseUrl = () => {
  const win = getWindow();
  const override = import.meta.env?.VITE_AGENT_URL;
  if (override) return override.replace(/\/$/, "");

  const hostname = win?.location?.hostname || "localhost";
  const protocol = win?.location?.protocol === "https:" ? "https" : "http";
  return `${protocol}://${hostname}:3000`;
};

const httpBase = resolveAgentBaseUrl();

export const agentHttpBaseUrl = httpBase;
export const agentWsBaseUrl = httpBase.replace(/^http(s?):/, (_match, secure) => (secure ? "wss:" : "ws:"));
