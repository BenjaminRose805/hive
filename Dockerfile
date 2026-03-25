FROM oven/bun:latest

# Install git (needed for worktree commits) and clean up
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /workspace

ENTRYPOINT ["claude"]
