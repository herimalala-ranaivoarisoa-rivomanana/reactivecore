export default function createApplication({ Module }) {
  class Application {}
  Module({ providers: [] })(Application);

  return {
    application: Application,
    functions: { queries: {}, mutations: [] },
  };
}
