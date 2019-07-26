import { SimpleStorage, SimpleMutableFile } from "../util/storage.js";
import { typedArrayToBuffer, concatTypedArray } from "../util/buffer.js";
import { CriticalSection } from "../util/promise.js";
import { assert } from "../util/error.js";

export interface ChunkStorageClass {
	create(id: IDBValidKey, isLoaded: boolean): Promise<ChunkStorage>
}

export type ChunkStorageWriter = (data: Uint8Array, position: number) => Promise<void>

type ChunkStorageLoadResult = {
	startPosition: number
	currentSize: number
	writer: ChunkStorageWriter
}[]

export interface ChunkStorage {
	load(totalSize: number): Promise<ChunkStorageLoadResult>
	writer(position: number): ChunkStorageWriter
	persist(totalSize: number | undefined, final: boolean): Promise<void>
	getFile(): Promise<File> // must call persist(totalSize, true) first
	reset(): void // clear persistenceData; all writers are invalidated
	delete(): void // other methods can still be called
	read(position: number, size: number): Promise<ArrayBuffer>
}

export class MutableFileChunkStorage implements ChunkStorage {
	private static storage = SimpleStorage.create("files")

	private constructor(
		readonly id: IDBValidKey,
		private readonly file: SimpleMutableFile,
	) { }

	private readonly persistCriticalSection = new CriticalSection()

	// Written at totalSize for shared files
	// [ persistenceData.length - 1, (startPosition, currentSize)...  ]
	private persistenceData = new Float64Array([0])

	static async create(id: IDBValidKey, isLoaded: boolean) {
		const storage = await this.storage
		let mutableFile = isLoaded ?
			(await storage.get(id) as IDBMutableFile) : undefined
		if (!mutableFile) {
			mutableFile = await storage.mutableFile(`chunk-storage-${id}`)
			await storage.set(id, mutableFile)
		}
		return new this(id, new SimpleMutableFile(mutableFile))
	}

	async load(totalSize: number) {
		try {
			const BYTES = Float64Array.BYTES_PER_ELEMENT
			const size = new Float64Array(await this.file.read(BYTES, totalSize))[0]
			if (!size /* 0 | undefined */) return []
			const data = new Float64Array(
				await this.file.read(BYTES * (size + 1), totalSize))
			if (data.length !== size + 1) return []
			assert(this.persistenceData.length === 1) // cannot be called after writer
			this.persistenceData = data
		} catch (error) {
			console.warn('MutableFileChunkStorage.load', this.id, error)
		}

		const result: ChunkStorageLoadResult = []
		for (let i = 1; i < this.persistenceData.length; i += 2) {
			const startPosition = this.persistenceData[i]
			result.push({
				startPosition,
				currentSize: this.persistenceData[i + 1],
				writer: this.writer(startPosition, i)
			})
		}
		return result
	}

	writer(position: number, persistenceIndex?: number) {
		if (persistenceIndex === undefined) {
			persistenceIndex = this.persistenceData.length
			this.persistenceData = concatTypedArray([
				this.persistenceData, new Float64Array([position, 0])
			])!
			this.persistenceData[0] += 2
		}
		const currentSizeIndex = persistenceIndex + 1
		return async (data: Uint8Array, writePosition: number) => {
			if (!data.length) return
			await this.file.write(
				typedArrayToBuffer(data) as ArrayBuffer, writePosition)
			this.persistenceData[currentSizeIndex] =
				writePosition + data.byteLength - position
		}
	}

	persist(totalSize: number | undefined, final: boolean) {
		if (totalSize === undefined) return Promise.resolve()
		return this.persistCriticalSection.sync(async () => {
			if (final)
				await this.file.truncate(totalSize)
			else
				await this.file.write(typedArrayToBuffer(
					this.persistenceData) as ArrayBuffer, totalSize)
		})
	}

	async getFile() { return this.file.getFile() }

	reset() { this.persistenceData = new Float64Array([0]) }

	async delete() {
		const storage = await MutableFileChunkStorage.storage
		storage.delete(this.id)
		// other methods can still access the unlinked file
	}

	read(position: number, size: number) { return this.file.read(size, position) }
}
