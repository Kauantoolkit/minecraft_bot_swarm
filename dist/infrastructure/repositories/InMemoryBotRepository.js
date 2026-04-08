"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemoryBotRepository = void 0;
class InMemoryBotRepository {
    constructor() {
        this.store = new Map();
    }
    add(bot) {
        this.store.set(bot.id, bot);
    }
    findById(id) {
        return this.store.get(id);
    }
    findAll() {
        return Array.from(this.store.values());
    }
    remove(id) {
        this.store.delete(id);
    }
    count() {
        return this.store.size;
    }
}
exports.InMemoryBotRepository = InMemoryBotRepository;
//# sourceMappingURL=InMemoryBotRepository.js.map