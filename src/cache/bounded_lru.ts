// Port of internal/cache/bounded_lru.go: a capacity-bounded LRU map with an
// optional eviction callback. JS is single-threaded, so GetOrAdd's create
// function simply runs synchronously; it must not call back into the cache.
// Map iteration order is insertion order, so re-inserting a key on access
// moves it to the most-recent end and the first key is the least recent.

export class BoundedLRU<K, V> {
  private readonly capacity: number;
  private readonly entries = new Map<K, V>();
  private readonly onEvict?: (key: K, value: V) => void;

  constructor(capacity: number, onEvict?: (key: K, value: V) => void) {
    this.capacity = capacity < 1 ? 1 : Math.floor(capacity);
    this.onEvict = onEvict;
  }

  /** Returns the cached value or creates, stores and returns one. */
  getOrAdd(key: K, create: () => V): V {
    if (this.entries.has(key)) {
      const value = this.entries.get(key) as V;
      this.entries.delete(key);
      this.entries.set(key, value);
      return value;
    }
    const value = create();
    this.entries.set(key, value);
    if (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value as K;
      const evicted = this.entries.get(oldest) as V;
      this.entries.delete(oldest);
      this.onEvict?.(oldest, evicted);
    }
    return value;
  }

  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) as V;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }

  delete(key: K): boolean {
    if (!this.entries.has(key)) return false;
    const value = this.entries.get(key) as V;
    this.entries.delete(key);
    this.onEvict?.(key, value);
    return true;
  }

  get size(): number {
    return this.entries.size;
  }

  keys(): K[] {
    return [...this.entries.keys()];
  }

  clear(): void {
    this.entries.clear();
  }
}
