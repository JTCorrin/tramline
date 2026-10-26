ALTER TABLE `service_instance` ADD `tcp_port` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `service_instance_tcp_port_unique` ON `service_instance` (`tcp_port`);