CREATE TABLE `install_admin` (
	`user_id` text PRIMARY KEY NOT NULL,
	`granted_by` text,
	`granted_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
