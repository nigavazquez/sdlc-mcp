data "aws_vpc" "selected" {
  id      = var.vpc_id
  default = var.vpc_id == null ? true : null
}

data "aws_subnets" "selected" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.selected.id]
  }
}

locals {
  subnet_id = var.subnet_id != null ? var.subnet_id : sort(data.aws_subnets.selected.ids)[0]
}

# Un solo security group, con las reglas inline: el grupo es de este stack y de
# nadie más. Si otro repo le agrega una regla suelta, el próximo apply de acá la
# borra sin avisar (ver la nota de shared SGs en las convenciones de la casa).
resource "aws_security_group" "instance" {
  name        = "${local.name}-sg"
  description = "sdlc-mcp: HTTPS público, HTTP sólo para el desafío ACME"
  vpc_id      = data.aws_vpc.selected.id

  # 443: el MCP, el panel y el Authorization Server.
  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # 80: NO es para servir la app. Es el desafío HTTP-01 de Let's Encrypt; sin él
  # Caddy no puede emitir ni renovar el certificado. Caddy redirige a 443.
  ingress {
    description = "HTTP: ACME HTTP-01 y redirect a HTTPS"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # SSH sólo si alguien lo pide explícitamente. El acceso por default es SSM
  # Session Manager, que no necesita puerto abierto ni llave que rotar.
  dynamic "ingress" {
    for_each = length(var.ssh_allowed_cidrs) > 0 ? [1] : []
    content {
      description = "SSH"
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = var.ssh_allowed_cidrs
    }
  }

  egress {
    description = "Salida: ECR, Secrets Manager, ACME y los sistemas externos de los adapters"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# IP fija: el registro DNS del dominio apunta acá y sobrevive a un stop/start de la
# instancia. Sin esto, reiniciar la EC2 cambia la IP y rompe el login OIDC.
resource "aws_eip" "instance" {
  domain   = "vpc"
  instance = aws_instance.app.id
}
