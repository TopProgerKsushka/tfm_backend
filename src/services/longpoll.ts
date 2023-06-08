import { ObjectId, WithId } from "mongodb";
import { UserDoc } from "../types/user.js";

type EventResolver<T> = (result: T[] | PromiseLike<T[]>) => void;
type EventSubscriber<T> = { ei: number, resolver: EventResolver<T> };

/**
 * Этот абстрактный класс добавляет сервису функциональность
 * Long Poll. Т.к. у нас несколько сервисов, нуждающихся в этой
 * функциональности, было решено вынести её в отдельный класс.
 * Достаточно унаследовать сервис от LongPollService и реализовать
 * в нём несколько простых методов, которые определяют, как именно
 * сервис получает сущность (документ), как он добавляет к ней события,
 * как получает список событий из неё, а также метод проверки прав
 * запрашивающего пользователя на получение событий этой сущности.
 * 
 * Первый метод и так должен быть в любом сервисе, оперирующем
 * некоторой коллекцией, а остальные реализуются в пару строк каждый.
 */
export abstract class LongPollService<T, E> {
    #subs: Map<string, Set<EventSubscriber<E> > > = new Map();

    /**
     * Извлекает из обслуживаемой коллекции сущность по ID.
     */
    abstract get(id: ObjectId): Promise<WithId<T> >;

    /**
     * Добавляет событие в сущность с указанным ID.
     */
    abstract addEvent(id: ObjectId, event: E): Promise<void>;

    /**
     * Указывает, каким образом массив событий должен извлекаться из сущности.
     */
    abstract extractEvents(doc: WithId<T>): E[];

    /**
     * Проверяет, может ли пользователь получать события о сущности.
     * Если нет, бросает AccessError.
     */
    abstract checkEventRequestRights(requestor: WithId<UserDoc>, doc: WithId<T>): void;

    /**
     * Публикует событие, отправляя его всем подписчикам.
     * @param id ID коллекции, с которой ассоциировать событие
     * @param event Событие
     */
    async publishEvent(id: ObjectId, event: E) {
        await this.addEvent(id, event);

        if (this.#subs.has(id.toString())) {
            const subs = this.#subs.get(id.toString())!;
            const events = await this.extractEvents(await this.get(id));
            for (const sub of subs) {
                if (sub.ei < events.length) {
                    sub.resolver( events.slice(sub.ei) );
                    subs.delete(sub);
                }
            }
        }
    }

    /**
     * Возвращает все опубликованные события, начиная с события с индексом `ei`, если такие есть на момент вызова.
     * В противном случае ожидает появления события с индексом `ei` в течение таймаута.
     * По истечении таймаута, возвращает пустой массив и отменяет подписку.
     * @param requestor Запрашивающий пользователь
     * @param id ID коллекции, события которой запрашиваются
     * @param ei Индекс события
     * @param timeout Таймаут
     * @returns Массив событий
     */
    async getEventsAfter(requestor: WithId<UserDoc>, id: ObjectId, ei: number, timeout?: number): Promise<E[]> {
        const doc = await this.get(id);

        this.checkEventRequestRights(requestor, doc);
        
        const events = this.extractEvents(doc);
        if (ei < events.length) return events.slice(ei);

        return new Promise((resolver) => {
            if (!this.#subs.has(id.toString()))
                this.#subs.set(id.toString(), new Set());
            const subs = this.#subs.get(id.toString())!;
            const sub = { ei, resolver };
            subs.add(sub);
            if (timeout !== undefined)
                setTimeout(() => {
                    subs.delete(sub);
                    resolver([]);
                }, timeout);
        });
    }
}