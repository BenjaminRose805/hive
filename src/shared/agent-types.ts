export interface AgentEntry {
  name: string
  role?: string
  status?: string
  created?: string
  branch?: string
  lastActive?: string
}

export interface AgentsJson {
  agents: AgentEntry[]
  created: string
  mode: string
}
