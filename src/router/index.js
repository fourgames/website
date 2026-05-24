import { createRouter, createWebHistory } from "vue-router";
import HomeView from "../views/HomeView.vue";
import NotFoundView from "../views/NotFoundView.vue";
import OpenSourceView from "../views/OpenSourceView.vue";
import JobsView from "../views/JobsView.vue";

const router = createRouter({
	history: createWebHistory(import.meta.env.BASE_URL),
	routes: [
		{
			path: "/",
			name: "home",
			component: HomeView,
		},
		{
			path: "/code",
			name: "code",
			component: OpenSourceView,
		},
		{
			path: "/jobs",
			name: "jobs",
			component: JobsView,
			//   props: true,
		},
		// Redirect
		// {
		//   path: '/all-jobs',
		//   redirect: '/jobs',
		// },
		// catch all route - 404 Not Found
		{
			path: "/:catchAll(.*)",
			name: "404",
			component: NotFoundView,
		},
	],
});

export default router;
