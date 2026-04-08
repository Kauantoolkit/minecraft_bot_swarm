import { Bot } from '../../domain/entities/Bot';
import { IBotRepository } from '../../domain/repositories/IBotRepository';
export declare class InMemoryBotRepository implements IBotRepository {
    private readonly store;
    add(bot: Bot): void;
    findById(id: string): Bot | undefined;
    findAll(): Bot[];
    remove(id: string): void;
    count(): number;
}
//# sourceMappingURL=InMemoryBotRepository.d.ts.map