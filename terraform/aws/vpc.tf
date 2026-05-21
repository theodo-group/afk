resource "aws_vpc" "afk" {
  cidr_block           = var.vpc_cidr
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name = "${var.project_name}-vpc"
  }
}

resource "aws_internet_gateway" "afk" {
  vpc_id = aws_vpc.afk.id

  tags = {
    Name = "${var.project_name}-igw"
  }
}

resource "aws_subnet" "public" {
  count = length(var.public_subnet_cidrs)

  vpc_id                  = aws_vpc.afk.id
  cidr_block              = var.public_subnet_cidrs[count.index]
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name = "${var.project_name}-public-${data.aws_availability_zones.available.names[count.index]}"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.afk.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.afk.id
  }

  tags = {
    Name = "${var.project_name}-public-rt"
  }
}

resource "aws_route_table_association" "public" {
  count = length(aws_subnet.public)

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# Security group attached to every Run. Inbound is fully denied (ECS Exec uses
# the SSM control plane, not inbound TCP). Outbound is unrestricted so the Run
# can reach ECR, SSM, CloudWatch, GitHub, and the agent's API.
resource "aws_security_group" "runs" {
  name        = "${var.project_name}-runs"
  description = "Security group for AFK Runs. No inbound; all outbound."
  vpc_id      = aws_vpc.afk.id

  egress {
    description      = "All outbound"
    from_port        = 0
    to_port          = 0
    protocol         = "-1"
    cidr_blocks      = ["0.0.0.0/0"]
    ipv6_cidr_blocks = ["::/0"]
  }

  tags = {
    Name = "${var.project_name}-runs"
  }
}
