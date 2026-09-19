resource "aws_dynamodb_table" "pull_request_state" {
  name         = var.dynamodb_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "repository"
  range_key    = "pull_request_number"

  attribute {
    name = "repository"
    type = "S"
  }

  attribute {
    name = "pull_request_number"
    type = "N"
  }

  point_in_time_recovery {
    enabled = true
  }

  tags = {
    Name = var.dynamodb_table_name
  }
}
