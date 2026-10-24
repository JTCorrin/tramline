import type {
	Backup,
	BackupQuery,
	BackupStorage,
	SaveBackupStorage,
	UpdateVolume,
	Volume,
	VolumeQuery
} from '@tramline/contracts';
import type { Http } from '../http';

export const backups = (http: Http) => ({
	storage: () => http.get<{ storage: BackupStorage | null; canManage: boolean }>('/backup-storage'),
	saveStorage: (input: SaveBackupStorage) => http.put<BackupStorage>('/backup-storage', input),
	removeStorage: () => http.delete<void>('/backup-storage'),
	testStorage: () => http.post<{ ok: true }>('/backup-storage/test'),
	volumes: (query: VolumeQuery) => http.get<Volume[]>('/volumes', query),
	updateVolume: (id: string, patch: UpdateVolume) => http.patch<Volume>(`/volumes/${id}`, patch),
	getAll: (query: BackupQuery) => http.get<Backup[]>('/backups', query),
	create: (volumeId: string) => http.post<Backup>('/backups', { volumeId }),
	remove: (id: string) => http.delete<void>(`/backups/${id}`),
	restore: (id: string) => http.post<Backup>(`/backups/${id}/restore`)
});
