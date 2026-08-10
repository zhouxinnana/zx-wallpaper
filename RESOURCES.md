# Vue to Java Full-Stack Architecture Resources

## Knowledge

- [Vue: Guide - Components Basics](https://vuejs.org/guide/essentials/component-basics.html)
  Official explanation of component boundaries and props/events. Use for: keeping UI state and presentation responsibilities clear.
- [Spring: Building a RESTful Web Service](https://spring.io/guides/gs/rest-service/)
  Official minimal path from an HTTP endpoint to a JSON response. Use for: the first controller and request/response contract.
- [Spring Boot: Reference Documentation](https://docs.spring.io/spring-boot/documentation.html)
  Official configuration and production-readiness reference. Use for: application setup, testing, and operational behavior.
- [Spring Data JPA: Reference Documentation](https://docs.spring.io/spring-data/jpa/reference/)
  Official guide to persistence repositories and transactional data access. Use for: database mapping after the HTTP contract is stable.
- [Spring Security: Reference](https://docs.spring.io/spring-security/reference/)
  Official security architecture reference. Use for: authentication and authorization once an application has protected behavior.
- [OpenAI: API Documentation](https://platform.openai.com/docs/overview)
  Official API documentation. Use for: understanding where model calls belong in a product architecture, after the core application boundary is clear.

## Wisdom (Communities)

- [Spring Forum](https://discuss.spring.io/)
  Official Spring community. Use for: framework-specific design and configuration questions after reducing them to a minimal example.
- [Vue Land Discord](https://vue-land.github.io/)
  Community-maintained Vue discussion space. Use for: Vue architecture and ecosystem trade-offs.

## Gaps

- The first course materials use primary documentation. Later lessons should add a current, production-focused source for observability and deployment after the first full-stack feature is complete.
