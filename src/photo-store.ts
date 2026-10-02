export interface Photo {
  id: number;
  original: Blob;
  thumbnailUrl: string;
  width: number;
  height: number;
  createdAt: Date;
  downloadStarted?: boolean;
}

export class PhotoStore {
  private photos = new Map<number, Photo>();
  private nextId = 1;
  private deletedPhoto: Photo | null = null;

  add(original: Blob, thumbnail: Blob, width: number, height: number): Photo {
    const photo: Photo = {
      id: this.nextId++, original, thumbnailUrl: URL.createObjectURL(thumbnail),
      width, height, createdAt: new Date(),
    };
    this.photos.set(photo.id, photo);
    return photo;
  }

  get(id: number): Photo | undefined { return this.photos.get(id); }
  list(): Photo[] { return [...this.photos.values()].sort((a, b) => b.id - a.id); }

  get canUndo(): boolean { return this.deletedPhoto !== null; }
  get hasUnsavedPhotos(): boolean { return [...this.photos.values()].some(photo => !photo.downloadStarted); }

  markDownloaded(id: number): void {
    const photo = this.photos.get(id);
    if (photo) photo.downloadStarted = true;
  }

  removeUndoable(id: number): void {
    const photo = this.photos.get(id);
    if (!photo) return;
    if (this.deletedPhoto) URL.revokeObjectURL(this.deletedPhoto.thumbnailUrl);
    this.deletedPhoto = photo;
    this.photos.delete(id);
  }

  undoRemove(): Photo | null {
    const photo = this.deletedPhoto;
    if (!photo) return null;
    this.photos.set(photo.id, photo);
    this.deletedPhoto = null;
    return photo;
  }

  remove(id: number): void {
    const photo = this.photos.get(id);
    if (!photo) return;
    URL.revokeObjectURL(photo.thumbnailUrl);
    this.photos.delete(id);
  }

  clear(): void {
    for (const id of this.photos.keys()) this.remove(id);
    if (this.deletedPhoto) URL.revokeObjectURL(this.deletedPhoto.thumbnailUrl);
    this.deletedPhoto = null;
  }
}

export function photoFilename(photo: Photo): string {
  const date = photo.createdAt;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `photo-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.png`;
}
