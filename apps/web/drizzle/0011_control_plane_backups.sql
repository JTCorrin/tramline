CREATE TABLE `control_plane_backup` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`object_key` text,
	`size` integer,
	`detail` text,
	`error` text,
	`created_at` integer NOT NULL
);
