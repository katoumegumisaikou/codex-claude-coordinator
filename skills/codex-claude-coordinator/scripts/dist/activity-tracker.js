export class ToolActivityTracker {
    #active = new Map();
    #finishedToolUseIds = new Set();
    #nextOrder = 0;
    start(event, activity) {
        if (event.toolUseId && this.#finishedToolUseIds.has(event.toolUseId))
            return false;
        const key = event.toolUseId
            ? `tool:${event.toolUseId}`
            : event.eventId
                ? `event:${event.eventId}`
                : `fallback:${event.agentId ?? ""}:${event.toolName ?? ""}:${event.timestamp}`;
        this.#active.set(key, { order: this.#nextOrder, activity });
        this.#nextOrder += 1;
        return true;
    }
    finish(event) {
        if (event.toolUseId) {
            this.#finishedToolUseIds.add(event.toolUseId);
            const finished = this.#active.get(`tool:${event.toolUseId}`)?.activity;
            this.#active.delete(`tool:${event.toolUseId}`);
            return finished;
        }
        const candidates = [...this.#active.entries()]
            .filter(([, value]) => (!event.agentId || value.activity.agentId === event.agentId)
            && (!event.toolName || value.activity.toolName === event.toolName))
            .sort((left, right) => right[1].order - left[1].order);
        const candidate = candidates[0];
        if (!candidate)
            return undefined;
        this.#active.delete(candidate[0]);
        return candidate[1].activity;
    }
    removeAgent(agentId) {
        for (const [key, value] of this.#active) {
            if (value.activity.agentId === agentId)
                this.#active.delete(key);
        }
    }
    latest() {
        return [...this.#active.values()].sort((left, right) => right.order - left.order)[0]?.activity;
    }
    latestForAgent(agentId) {
        return [...this.#active.values()]
            .filter((value) => value.activity.agentId === agentId)
            .sort((left, right) => right.order - left.order)[0]?.activity;
    }
    get size() {
        return this.#active.size;
    }
}
//# sourceMappingURL=activity-tracker.js.map