-- AlterEnum: a user-cancelled upload is distinct from a failed one.
ALTER TYPE "AttachmentStatus" ADD VALUE 'CANCELLED';
