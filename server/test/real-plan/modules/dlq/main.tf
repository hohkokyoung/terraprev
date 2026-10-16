variable "name" { type = string }

resource "aws_sqs_queue" "this" {
  name                      = var.name
  message_retention_seconds = 1209600
}

output "arn" { value = aws_sqs_queue.this.arn }
