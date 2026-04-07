import { Bot } from '../entities/Bot';

export interface IBotRepository {
  add(bot: Bot): void;
  findById(id: string): Bot | undefined;
  findAll(): Bot[];
  remove(id: string): void;
  count(): number;
}
