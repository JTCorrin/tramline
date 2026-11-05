ALTER TABLE `custom_domain` ADD `route` text DEFAULT 'direct' NOT NULL;--> statement-breakpoint
ALTER TABLE `public_tunnel` ADD `app_records` text;