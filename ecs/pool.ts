// TODO do we want to track in use and allow a releaseAll?
export class Pool<T> {
    protected _create: () => T;
    protected _release: (item: T) => void;

    pool = new Set<T>();

    constructor(create: () => T, release: (item: T) => void, seedCount = 25) {
        this._create = create;
        this._release = release;

        this.fill(seedCount);
    }

    use(item = this.pool.first()) {
        if (item) {
            this.pool.delete(item);
        } else {
            item = this._create();
        }

        return item;
    }

    release(item = this._create()) {
        this._release(item);
        this.pool.add(item);

        return item;
    }

    fill(count = 1) {
        for (let i = 0; i < count; i++) {
            this.release();
        }
    }
}

export class PooledMap<K, T> extends Map<K, T> {
    pool: Pool<T>;

    constructor(create: () => T, release: (item: T) => void, seedCount = 25) {
        super();

        this.pool = new Pool(create, release, seedCount);
    }

    getOrCreate(key: K) {
        if (!this.has(key)) {
            this.set(key);
        }

        return this.get(key) as T;
    }

    set(key: K): this;
    set(key: K, value?: T): this {
        if (!value) {
            value = this.pool.use();
        }

        return super.set(key, value);
    }

    delete(key: K) {
        if (this.has(key)) {
            this.pool.release(this.get(key));
        }

        return super.delete(key);
    }

    clear() {
        for (let key of this.keys()) {
            this.delete(key);
        }
    }
}
