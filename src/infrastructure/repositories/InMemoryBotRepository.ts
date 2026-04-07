import { Bot } from '../../domain/entities/Bot';
import { IBotRepository } from '../../domain/repositories/IBotRepository';

export class InMemoryBotRepository implements IBotRepository {
  private readonly store = new Map<string, Bot>();

  add(bot: Bot): void {
    this.store.set(bot.id, bot);
  }

  findById(id: string): Bot | undefined {
    return this.store.get(id);
  }

  findAll(): Bot[] {
    return Array.from(this.store.values());
  }

  remove(id: string): void {
    this.store.delete(id);
  }

  count(): number {
    return this.store.size;
  }
}
