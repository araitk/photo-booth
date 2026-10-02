export interface Photo {
  id: number;
  original: Blob;
  thumbnailUrl: string;
  width: number;
  height: number;
  createdAt: Date;
}

export class PhotoStore {
  private photos = new Map<number, Photo>();
  private nextId = 1;

  add(original: Blob, thumbnail: Blob, width: number, height: number): Photo {
    const photo: Photo = {
      id: this.nextId++, original, thumbnailUrl: URL.createObjectURL(thumbnail),
      width, height, createdAt: new Date(),
    };
    this.photos.set(photo.id, photo);
    return photo;
  }

  get(id: number): Photo | undefined { return this.photos.get(id); }
  list(): Photo[] { return [...this.photos.values()].reverse(); }

  remove(id: number): void {
    const photo = this.photos.get(id);
    if (!photo) return;
    URL.revokeObjectURL(photo.thumbnailUrl);
    this.photos.delete(id);
  }

  clear(): void {
    for (const id of this.photos.keys()) this.remove(id);
  }
}

export function photoFilename(photo: Photo): string {
  const date = photo.createdAt;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `photo-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${photo.id}.png`;
}
