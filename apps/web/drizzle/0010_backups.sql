CREATE TABLE `backup` (
	`id` text PRIMARY KEY NOT NULL,
	`volume_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`kind` text NOT NULL,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`object_key` text NOT NULL,
	`wrapped_key` text NOT NULL,
	`size` integer,
	`error` text,
	`node_id` text,
	`created_by` text,
	`finished_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`volume_id`) REFERENCES `volume`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`node_id`) REFERENCES `node`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `backup_volume_idx` ON `backup` (`volume_id`);--> statement-breakpoint
CREATE TABLE `backup_storage` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`endpoint` text NOT NULL,
	`region` text NOT NULL,
	`bucket` text NOT NULL,
	`prefix` text NOT NULL,
	`access_key_id` text NOT NULL,
	`secret_access_key` text NOT NULL,
	`path_style` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `restore` (
	`id` text PRIMARY KEY NOT NULL,
	`backup_id` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`created_by` text,
	`finished_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`backup_id`) REFERENCES `backup`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `restore_backup_idx` ON `restore` (`backup_id`);--> statement-breakpoint
ALTER TABLE `volume` ADD `backup_schedule` text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE `volume` ADD `backup_retention` integer DEFAULT 7 NOT NULL;